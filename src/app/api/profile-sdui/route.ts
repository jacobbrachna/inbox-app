import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import { parseSdui } from '@/lib/sdui-parse';
import { logParserResult } from '@/lib/parser-log';
import type { Participant } from '@/types';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// POST { url, profileSlug, body } — receives one SDUI component response
// from LinkedIn's profile rendering. Two jobs:
//   1. Persist a raw sample under /tmp/inboxpro-sdui/ so we can iterate on
//      the parser when LinkedIn shifts shape.
//   2. Extract structured fields (about, prevRoles, education, recentPosts,
//      skills, jobChangeSignal) via parseSdui, then merge into the matching
//      Contact + any Conversations where the participant has this profileUrl.
//
// Conservative: never CREATES a Contact from this path. Only enriches
// existing ones found by profileSlug.

const OUT_DIR = '/tmp/inboxpro-sdui';

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 120);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = typeof body?.url === 'string' ? body.url : '';
    const slug = typeof body?.profileSlug === 'string' ? body.profileSlug : '';
    const payload = typeof body?.body === 'string' ? body.body : '';
    if (!url || !payload) {
      return NextResponse.json({ error: 'url and body required' }, { status: 400, headers: CORS });
    }
    const cidMatch = url.match(/componentId=([^&]+)/);
    const cid = cidMatch ? cidMatch[1] : 'unknown';
    const shortCid = cid.split('.').slice(-1)[0];

    // 1. Persist raw sample for future debugging
    try {
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(join(OUT_DIR, `${safeName(slug || 'unknown')}__${safeName(shortCid)}.json`), payload, 'utf-8');
    } catch {
      // ENOENT etc. — non-fatal
    }

    // 2. Parse and persist if we have a slug to associate
    if (!slug) {
      return NextResponse.json({ ok: true, parsed: false, reason: 'no slug' }, { headers: CORS });
    }
    const extracted = parseSdui(cid, payload);
    const fields = Object.keys(extracted);

    // Only log to parser-health for components we EXPECT to extract from.
    // LinkedIn fires ~10-13 SDUI components per profile (recommendations,
    // related entities, etc.) that aren't part of our scrape surface.
    // Logging all of them as failures gave a meaningless ~17% success rate.
    //
    // Strict signal — failure on these means LinkedIn likely changed the
    // component shape:
    //   • profileCardsAboveActivity → always has About / skills / sales insights
    //   • profileCardsBelowActivityPart1 → always has experience / education
    // Other component types are skipped from telemetry entirely.
    const isCoreParseable = shortCid === 'profileCardsAboveActivity' || shortCid === 'profileCardsBelowActivityPart1';
    if (fields.length === 0) {
      if (isCoreParseable) {
        logParserResult('sdui-parse', false, { shortCid, reason: 'no-fields' });
      }
      return NextResponse.json({ ok: true, parsed: false, reason: 'no fields extracted', shortCid }, { headers: CORS });
    }
    if (isCoreParseable) {
      logParserResult('sdui-parse', true, { shortCid, fieldCount: fields.length });
    }

    // Is this the user's OWN profile? If so route the extracted data into
    // AppState (employment history + auto-fill empty Your context fields),
    // not into a Contact row. Returns early — we never create a self-Contact.
    const appState = await prisma.appState.findUnique({ where: { id: 1 } });
    if (appState?.myProfileSlug && appState.myProfileSlug === slug) {
      const now = new Date();
      const patch: Record<string, unknown> = { myProfileRefreshedAt: now };
      if (Array.isArray(extracted.prevRoles) && extracted.prevRoles.length > 0) {
        patch.myEmploymentHistory = JSON.stringify(extracted.prevRoles);
        // Auto-fill current role/company only if empty — never overwrite
        // a value the user has typed themselves.
        const current = extracted.prevRoles.find((r) => r.to === null || /present/i.test(r.to ?? ''));
        if (current) {
          if (!appState.myRole && current.role) patch.myRole = current.role;
          if (!appState.myCompany && current.company) patch.myCompany = current.company;
        }
      }
      if (Object.keys(patch).length > 1) {
        await prisma.appState.update({ where: { id: 1 }, data: patch });
      }
      return NextResponse.json({ ok: true, parsed: true, persisted: 'appstate', fields }, { headers: CORS });
    }

    const contact = await prisma.contact.findUnique({ where: { profileSlug: slug } });
    if (!contact) {
      return NextResponse.json({ ok: true, parsed: true, persisted: false, reason: 'no matching contact', fields }, { headers: CORS });
    }

    const now = new Date();
    const patch: Record<string, unknown> = { lastSeenAt: now };
    if (typeof extracted.about === 'string' && extracted.about.length > 0) patch.about = extracted.about;
    if (Array.isArray(extracted.prevRoles) && extracted.prevRoles.length > 0) patch.prevRoles = JSON.stringify(extracted.prevRoles);
    if (Array.isArray(extracted.education) && extracted.education.length > 0) patch.education = JSON.stringify(extracted.education);
    if (Array.isArray(extracted.skills) && extracted.skills.length > 0) patch.skills = JSON.stringify(extracted.skills);
    if (Array.isArray(extracted.recentPosts) && extracted.recentPosts.length > 0) {
      patch.recentPosts = JSON.stringify(extracted.recentPosts);
      patch.recentPostsAt = now;
    }

    if (Object.keys(patch).length > 1) {
      await prisma.contact.update({ where: { id: contact.id }, data: patch });
    }

    // 3. Mirror to matched conversations so the right panel renders immediately
    const profileUrl = `https://www.linkedin.com/in/${slug}/`;
    const convs = await prisma.conversation.findMany({
      where: { participants: { contains: profileUrl } },
      select: { id: true, enrichment: true, participants: true },
    });
    let mirrored = 0;
    for (const c of convs) {
      const parts = safeParseArray<Participant>(c.participants, []);
      if (!parts[0]?.profileUrl?.includes(`/in/${slug}`)) continue;
      let existing: Record<string, unknown> = {};
      if (c.enrichment) {
        try { existing = JSON.parse(c.enrichment); } catch {}
      }
      const merged: Record<string, unknown> = {
        ...existing,
        ...(typeof extracted.about === 'string' ? { about: extracted.about } : {}),
        ...(Array.isArray(extracted.prevRoles) ? { prevRoles: extracted.prevRoles } : {}),
        ...(Array.isArray(extracted.education) ? { education: extracted.education } : {}),
        ...(Array.isArray(extracted.skills) ? { skills: extracted.skills } : {}),
        ...(Array.isArray(extracted.recentPosts) ? { recentPosts: extracted.recentPosts } : {}),
        profileUrl: existing.profileUrl ?? profileUrl,
        source: 'dom-capture',
      };
      await prisma.conversation.update({
        where: { id: c.id },
        data: { enrichment: JSON.stringify(merged), enrichmentAt: now },
      });
      mirrored++;
    }

    return NextResponse.json(
      { ok: true, parsed: true, persisted: true, fields, mirrored, shortCid },
      { headers: CORS },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500, headers: CORS },
    );
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
