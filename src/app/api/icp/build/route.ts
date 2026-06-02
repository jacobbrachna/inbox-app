import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';

// POST /api/icp/build
//   { websiteUrl?, linkedinUrl?, outreachGoal?, companyName?, companyOneLiner? }
//
// Synthesizes a structured ICP definition. Persists the inputs + the
// derived definition on AppState. The deterministic scorer in
// /api/icp/rescore reads the definition to score every conversation
// without any further Claude calls.
//
// Source material gathered in this order:
//   1. The user's free-text fields (outreachGoal, idealCustomerProfile,
//      companyOneLiner, myCompany, myRole, keyValueProps).
//   2. A fetched + sanitized excerpt of the company website (best-effort —
//      JS-rendered sites may give nothing; we proceed without).
//   3. Skipped for v1: LinkedIn company page scrape — requires the extension
//      and is deferred.

const PROMPT = `You build a structured Ideal Customer Profile (ICP) for an SDR/outbound seller. Your output drives a deterministic scoring engine, so be PRECISE and COMPREHENSIVE.

Given the seller's company info and their stated targeting, output a JSON object describing who they should reach out to. The structure:

{
  "targetTitles": [string],       // 10-30 literal job titles, lowercase. Be broad — include every variant (CISO, Chief Information Security Officer, VP of Security, Head of Information Security, etc.). Substring-match friendly.
  "titlePatterns": [string],      // 3-8 regex strings (case-insensitive) covering title families. e.g. "director.*(security|risk|privacy)", "head of (data|cyber|security)". Use these for messy real-world titles.
  "keywords": [string],           // 5-15 topical keywords likely to appear in target contacts' headlines/about. e.g. "DSPM", "data security", "compliance", "GRC".
  "seniorityWeights": {           // 0-100 weight per seniority level. Heavier weight → bigger contributor to score.
    "C-level": 100,
    "Founder": 70,
    "VP": 95,
    "Head": 90,
    "Director": 85,
    "Manager": 60,
    "Senior IC": 50,
    "IC": 30
  },
  "industries": [string],         // 3-8 target industries / verticals.
  "excludeTitles": [string]       // 3-10 titles that should NEVER score (sales engineers, customer success, recruiters, students, etc.).
}

Adjust seniorityWeights based on the seller's stated targeting. If they reach out mostly to "leaders", weight C-level/VP/Director high and IC low. If they target practitioners, raise Senior IC and lower C-level slightly.

Output ONLY valid JSON, no surrounding text.`;

interface BuildRequest {
  websiteUrl?: string;
  linkedinUrl?: string;
  outreachGoal?: string;
  companyName?: string;
  companyOneLiner?: string;
}

// Strip HTML, scripts, styles. Keep visible text. Cap at ~12k chars so Claude
// doesn't drown in nav/footer noise.
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12_000);
}

async function fetchSite(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Relay/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    return extractText(html);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  let body: BuildRequest = {};
  try { body = await req.json(); } catch {}

  // Merge with stored AppState so the user can re-run without re-entering.
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  const websiteUrl = (body.websiteUrl ?? state?.companyWebsiteUrl ?? '').trim();
  const linkedinUrl = (body.linkedinUrl ?? state?.companyLinkedInUrl ?? '').trim();
  const outreachGoal = (body.outreachGoal ?? state?.outreachGoal ?? '').trim();
  const companyName = (body.companyName ?? state?.myCompany ?? '').trim();
  const companyOneLiner = (body.companyOneLiner ?? state?.companyOneLiner ?? '').trim();

  // Persist the inputs so the user can re-run the builder with edits later.
  await prisma.appState.update({
    where: { id: 1 },
    data: {
      companyWebsiteUrl: websiteUrl || null,
      companyLinkedInUrl: linkedinUrl || null,
      outreachGoal: outreachGoal || null,
      myCompany: companyName || null,
      companyOneLiner: companyOneLiner || null,
    },
  });

  // Best-effort site fetch. We don't fail the build if it errors out — the
  // seller's free text alone is usually enough for Claude.
  const siteText = websiteUrl ? await fetchSite(websiteUrl) : null;

  // Assemble the user message.
  const lines: string[] = [];
  if (companyName) lines.push(`Seller's company: ${companyName}`);
  if (companyOneLiner) lines.push(`One-liner: ${companyOneLiner}`);
  if (outreachGoal) lines.push(`Targeting (seller's own words): ${outreachGoal}`);
  if (websiteUrl) lines.push(`Website: ${websiteUrl}`);
  if (linkedinUrl) lines.push(`LinkedIn page: ${linkedinUrl}`);
  if (siteText) lines.push(`\nWebsite content (auto-extracted, may be partial):\n${siteText}`);

  if (lines.length === 0) {
    return NextResponse.json(
      { error: 'No source material — provide at least one of: website, outreach goal, company description' },
      { status: 400, headers: CORS },
    );
  }

  let client;
  try {
    client = await requireAnthropic();
  } catch {
    return NextResponse.json(
      { error: 'No Anthropic API key configured' },
      { status: 400, headers: CORS },
    );
  }

  const resp = await client.messages.create({
    model: MODELS.draft, // sonnet — this is a one-time call worth the quality
    max_tokens: 2000,
    system: PROMPT,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = resp.content.map((b) => ('text' in b ? b.text : '')).join('').trim();

  // Extract JSON — Claude usually emits clean JSON with this prompt but
  // tolerate a code-fenced wrapper.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return NextResponse.json(
      { error: 'Claude did not return JSON', raw: text.slice(0, 500) },
      { status: 500, headers: CORS },
    );
  }
  let definition: unknown;
  try {
    definition = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return NextResponse.json(
      { error: `JSON parse failed: ${e instanceof Error ? e.message : 'unknown'}`, raw: text.slice(0, 500) },
      { status: 500, headers: CORS },
    );
  }

  await prisma.appState.update({
    where: { id: 1 },
    data: {
      icpDefinition: JSON.stringify(definition),
      icpBuiltAt: new Date(),
    },
  });

  return NextResponse.json(
    {
      ok: true,
      definition,
      sourceCharCount: siteText?.length ?? 0,
    },
    { headers: CORS },
  );
}

export async function OPTIONS() {
  return optionsResponse();
}
