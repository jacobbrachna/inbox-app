import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import type { Participant } from '@/types';
import { upsertContact, linkContactToConversation, extractProfileSlug, parseLinkedInDate } from '@/lib/contact-upsert';

// POST { csv: string }  — uploads LinkedIn's Connections.csv export.
// Format LinkedIn provides:
//   Notes:
//   "When exporting…"
//   <blank>
//   First Name,Last Name,URL,Email Address,Company,Position,Connected On
//   Kiran,Kumar,https://www.linkedin.com/in/kiran-kumar-b58971b2,,Socure,Senior Security Engineer,12 May 2026
//
// We skip the preamble until we find the header row, parse the rest,
// then match against existing contacts using the same logic as bulk capture
// (but with verified data so we OVERRIDE any prior AI-derived enrichment).

function normalize(s: string): string {
  return s
    .toLowerCase()
    .split(',')[0]
    .replace(/\([^)]*\)/g, '')
    .replace(/[^\p{L}\p{N}\s'.-]/gu, '')
    .replace(/[.'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameFromSlug(url: string): string {
  try {
    const u = new URL(url);
    const slug = u.pathname.replace(/^\/in\/|\/+$/g, '');
    const parts = slug.split('-');
    while (parts.length && /^[a-z0-9]{5,}$/i.test(parts[parts.length - 1])) parts.pop();
    return parts.join(' ');
  } catch { return ''; }
}

// Minimal CSV parser — handles double-quote escaping which LinkedIn does use.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

interface CsvRow {
  firstName: string;
  lastName: string;
  url: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
}

function parseLinkedInCsv(csv: string): CsvRow[] {
  const lines = csv.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    if (/^First Name,/.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('Could not find header row — is this the right CSV?');
  const headers = parseCsvLine(lines[headerIdx]);
  const idx = (label: string) => headers.findIndex((h) => h.trim().toLowerCase() === label.toLowerCase());
  const iFirst = idx('First Name');
  const iLast = idx('Last Name');
  const iUrl = idx('URL');
  const iEmail = idx('Email Address');
  const iCompany = idx('Company');
  const iPos = idx('Position');
  const iOn = idx('Connected On');

  const rows: CsvRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 3) continue;
    rows.push({
      firstName: (f[iFirst] ?? '').trim(),
      lastName: (f[iLast] ?? '').trim(),
      url: (f[iUrl] ?? '').trim(),
      email: (f[iEmail] ?? '').trim(),
      company: (f[iCompany] ?? '').trim(),
      position: (f[iPos] ?? '').trim(),
      connectedOn: (f[iOn] ?? '').trim(),
    });
  }
  return rows;
}

function canonicalizeUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') + '/';
    return `https://www.linkedin.com${path}`;
  } catch {
    return url.endsWith('/') ? url : url + '/';
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const csv = typeof body?.csv === 'string' ? body.csv : '';
    if (!csv) {
      return NextResponse.json({ error: 'csv field required' }, { status: 400, headers: CORS });
    }

    let rows: CsvRow[];
    try { rows = parseLinkedInCsv(csv); }
    catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'CSV parse failed' },
        { status: 400, headers: CORS },
      );
    }

    // Build the same lookup indexes as the harvest path, but with verified
    // company/role metadata attached per URL.
    const byName = new Map<string, string>();
    const metaByUrl = new Map<string, { company?: string; role?: string; connectedOn?: string; email?: string }>();
    for (const r of rows) {
      const url = canonicalizeUrl(r.url);
      if (!url) continue;
      const fullName = `${r.firstName} ${r.lastName}`.trim();
      const keys = new Set<string>();
      if (fullName) keys.add(normalize(fullName));
      const slugKey = normalize(nameFromSlug(url));
      if (slugKey) keys.add(slugKey);
      for (const k of keys) {
        if (!k) continue;
        const existing = byName.get(k);
        if (!existing) byName.set(k, url);
      }
      metaByUrl.set(url, {
        ...(r.company ? { company: r.company } : {}),
        ...(r.position ? { role: r.position } : {}),
        ...(r.connectedOn ? { connectedOn: r.connectedOn } : {}),
        ...(r.email ? { email: r.email } : {}),
      });
    }

    // Upsert a Contact for every CSV row. linkedin-export is our highest
    // source-priority, so existing weaker enrichment gets overwritten.
    const contactIdByUrl = new Map<string, string>();
    let contactsUpserted = 0;
    for (const r of rows) {
      const url = canonicalizeUrl(r.url);
      if (!url) continue;
      const fullName = `${r.firstName} ${r.lastName}`.trim();
      if (!fullName) continue;
      const cid = await upsertContact({
        profileUrl: url,
        profileSlug: extractProfileSlug(url),
        name: fullName,
        company: r.company || null,
        role: r.position || null,
        connectedOn: parseLinkedInDate(r.connectedOn),
        source: 'linkedin-export',
      });
      if (cid) {
        contactIdByUrl.set(url, cid);
        contactsUpserted++;
      }
    }

    // Match against all conversations
    const convs = await prisma.conversation.findMany({
      select: { id: true, participants: true, enrichment: true },
    });

    let matched = 0;
    let updatedFields = 0;
    for (const c of convs) {
      const parts = safeParseArray<Participant>(c.participants, []);
      let participantChanged = false;
      const nextParts = parts.map((p) => {
        if (p.profileUrl) return p;
        const n = normalize(p.name ?? '');
        const url = n ? byName.get(n) : undefined;
        if (!url) return p;
        participantChanged = true;
        return { ...p, profileUrl: url };
      });

      // Even if profileUrl was already set, we want to update company/role
      // from the export (more trustworthy than headline-parsing).
      const primary = nextParts[0];
      const url = primary?.profileUrl;
      const meta = url ? metaByUrl.get(url) : undefined;

      if (!participantChanged && !meta) continue;

      let existingEnrichment: Record<string, unknown> = {};
      if (c.enrichment) {
        try { existingEnrichment = JSON.parse(c.enrichment); } catch {}
      }
      const enriched: Record<string, unknown> = { ...existingEnrichment };
      if (url) enriched.profileUrl = url;
      if (meta?.company) enriched.company = meta.company;
      if (meta?.role) enriched.role = meta.role;
      if (meta?.connectedOn) enriched.connectedOn = meta.connectedOn;
      if (meta?.email) enriched.email = meta.email;
      if (meta) enriched.source = 'linkedin-export';

      const updateData: Record<string, unknown> = {};
      if (participantChanged) updateData.participants = JSON.stringify(nextParts);
      if (url) {
        updateData.enrichment = JSON.stringify(enriched);
        updateData.enrichmentAt = new Date();
      }

      await prisma.conversation.update({ where: { id: c.id }, data: updateData });
      if (participantChanged) matched++;
      if (meta) updatedFields++;

      // Link each contact we know about for this conversation's participants.
      for (const p of nextParts) {
        if (!p.profileUrl) continue;
        const cid = contactIdByUrl.get(p.profileUrl);
        if (cid) await linkContactToConversation(cid, c.id);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        rowsParsed: rows.length,
        contactsMatched: matched,
        contactsEnriched: updatedFields,
        contactsUpserted,
      },
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
