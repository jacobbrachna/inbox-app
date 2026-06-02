import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse, safeParseArray } from '@/lib/api-utils';
import { enrichCompany, enrichScoops, enrichNews } from '@/lib/zoominfo';
import type { Participant } from '@/types';

// POST /api/conversations/:id/zoominfo-pull
//
// On-demand "Pull ZI signals" — fires three calls (company enrich + scoops
// + news) against the contact's company, caches the structured result on
// the Conversation row. Idempotent — re-runs replace the prior cache.
//
// Domain resolution:
//   1. participants[0].profileUrl → extract host? (rarely useful)
//   2. enrichment.company → use as a name
//   3. participants[0].headline → parse "Title at Company"
// The user can also explicitly pass a domain in the request body.

function deriveDomainAndName(parts: Participant[], enrichmentJson: string | null): {
  domain?: string;
  companyName?: string;
} {
  const p = parts[0];
  let enr: { company?: string } | null = null;
  if (enrichmentJson) {
    try { enr = JSON.parse(enrichmentJson); } catch {}
  }
  let companyName = enr?.company;
  // Headline like "Director of Security at Bedrock Data"
  if (!companyName && p?.headline) {
    const m = p.headline.match(/\bat\s+(.+?)(\s*[·•|]|$)/i);
    if (m) companyName = m[1].trim();
  }
  return { companyName };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: { domain?: string; companyName?: string } = {};
  try { body = await req.json(); } catch {}

  const conv = await prisma.conversation.findUnique({
    where: { id },
    select: { participants: true, enrichment: true },
  });
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404, headers: CORS });
  }
  const parts = safeParseArray<Participant>(conv.participants, []);
  const derived = deriveDomainAndName(parts, conv.enrichment);
  const domain = body.domain || derived.domain;
  const companyName = body.companyName || derived.companyName;

  if (!domain && !companyName) {
    return NextResponse.json(
      { error: 'No company domain or name to look up — pass {domain} or {companyName}' },
      { status: 400, headers: CORS },
    );
  }

  try {
    const company = await enrichCompany({ domain, companyName });
    if (!company) {
      const empty = { company: null, scoops: [], news: [] };
      await prisma.conversation.update({
        where: { id },
        data: { zoominfoData: JSON.stringify(empty), zoominfoPulledAt: new Date() },
      });
      return NextResponse.json({ ok: true, ...empty }, { headers: CORS });
    }

    // If we got a ZI company ID, use it for scoops + news (most precise).
    // Otherwise fall back to companyWebsites for scoops; skip news (it
    // requires the integer ID).
    const ziId = company.zoominfoCompanyId;
    const [scoops, news] = await Promise.all([
      ziId
        ? enrichScoops({ zoominfoCompanyIds: [ziId] })
        : (company.website ? enrichScoops({ companyWebsites: [company.website] }) : Promise.resolve([])),
      ziId ? enrichNews({ zoominfoCompanyId: ziId }) : Promise.resolve([]),
    ]);

    const data = { company, scoops, news };
    await prisma.conversation.update({
      where: { id },
      data: { zoominfoData: JSON.stringify(data), zoominfoPulledAt: new Date() },
    });
    return NextResponse.json({ ok: true, ...data }, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500, headers: CORS },
    );
  }
}

// GET — returns the cached ZI data on a conversation without re-fetching.
// Used by the contact panel on every open so we don't hit ZI on idle navigation.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const conv = await prisma.conversation.findUnique({
    where: { id },
    select: { zoominfoData: true, zoominfoPulledAt: true },
  });
  if (!conv?.zoominfoData) {
    return NextResponse.json({ cached: false }, { headers: CORS });
  }
  let data: unknown = null;
  try { data = JSON.parse(conv.zoominfoData); } catch {}
  return NextResponse.json({
    cached: true,
    pulledAt: conv.zoominfoPulledAt?.toISOString() ?? null,
    ...((data as object) ?? {}),
  }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
