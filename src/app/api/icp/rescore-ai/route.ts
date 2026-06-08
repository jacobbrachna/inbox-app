import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse, safeParseArray } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';
import type { Participant } from '@/types';

// POST /api/icp/rescore-ai  { offset?, limit? } → { scored, nextOffset, total, done }
//
// AI-powered ICP fit scoring: Haiku reads each contact's FULL profile (title,
// seniority, company, about) and reasons about fit holistically — catching the
// non-obvious fits the deterministic keyword scorer (/api/icp/rescore) misses.
// Batched via an offset cursor so the client (or a script) can loop it to
// completion; the ICP brief is sent as a cached system prompt so we only pay
// full input price for the per-contact data.

interface AiScore { fit: number; signal: string }

function clamp(n: number) { return Math.max(0, Math.min(100, Math.round(n))); }

function safeParse(s: string): AiScore | null {
  try {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (typeof j.fit !== 'number') return null;
    return { fit: clamp(j.fit), signal: typeof j.signal === 'string' ? j.signal.slice(0, 120) : '' };
  } catch { return null; }
}

function buildSystem(state: {
  myCompany?: string | null; companyOneLiner?: string | null;
  outreachGoal?: string | null; idealCustomerProfile?: string | null;
}): string {
  const lines = [
    "You score how well a LinkedIn contact fits an SDR's Ideal Customer Profile (ICP).",
    'Read the contact\'s FULL profile and reason about fit holistically — title, seniority, the company they work at, and their about/role — NOT just keyword matches.',
    '',
    'The seller:',
    state.myCompany ? `- Company: ${state.myCompany}${state.companyOneLiner ? ` — ${state.companyOneLiner}` : ''}` : '',
    state.outreachGoal ? `- Who they target: ${state.outreachGoal}` : '',
    state.idealCustomerProfile ? `- Ideal customer profile: ${state.idealCustomerProfile}` : '',
    '',
    'Score 0-100:',
    '- 80-100: strong fit (right seniority + right function/domain + right kind of company)',
    '- 60-79: good fit',
    '- 40-59: some/adjacent fit',
    '- 1-39: weak',
    '- 0: not a fit, OR an exclude (sales/solutions engineers, recruiters, CSMs, account managers, students, and peers at the seller\'s OWN company)',
    '',
    'Weigh company context: the same title is a stronger fit at a company matching the seller\'s target industries/profile than at an unrelated one.',
    '',
    'Output ONLY JSON: {"fit": <0-100 integer>, "signal": "<=12-word reason"}',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const offset = Math.max(0, Number(body?.offset) || 0);
  const limit = Math.min(120, Math.max(1, Number(body?.limit) || 60));

  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  if (!state?.outreachGoal && !state?.idealCustomerProfile) {
    return NextResponse.json({ error: 'No ICP targeting set — fill in the ICP Builder first.' }, { status: 400, headers: CORS });
  }

  let client;
  try { client = await requireAnthropic(); }
  catch { return NextResponse.json({ error: 'No Anthropic API key configured' }, { status: 400, headers: CORS }); }

  const total = await prisma.conversation.count({ where: { status: { not: 'archived' } } });
  const convs = await prisma.conversation.findMany({
    where: { status: { not: 'archived' } },
    orderBy: { id: 'asc' },
    skip: offset,
    take: limit,
    select: { id: true, participants: true, enrichment: true },
  });

  const system = [{ type: 'text' as const, text: buildSystem(state), cache_control: { type: 'ephemeral' as const } }];

  let scored = 0;
  let idx = 0;
  const CONCURRENCY = 6;
  async function worker() {
    while (idx < convs.length) {
      const c = convs[idx++];
      const parts = safeParseArray<Participant>(c.participants, []);
      const p = parts[0];
      let enr: { company?: string; role?: string; about?: string } = {};
      if (c.enrichment) { try { enr = JSON.parse(c.enrichment); } catch {} }
      const name = p?.name ?? 'Unknown';
      const headline = p?.headline ?? '';
      const profile = [
        `Contact: ${name}`,
        headline ? `Headline: ${headline}` : '',
        enr.company ? `Company: ${enr.company}` : '',
        enr.role ? `Role: ${enr.role}` : '',
        enr.about ? `About: ${enr.about.slice(0, 600)}` : '',
      ].filter(Boolean).join('\n');
      try {
        const resp = await client.messages.create({
          model: MODELS.fast,
          max_tokens: 60,
          system,
          messages: [{ role: 'user', content: profile }],
        });
        const text = resp.content.map((b) => ('text' in b ? b.text : '')).join('').trim();
        const parsed = safeParse(text);
        if (parsed) {
          await prisma.conversation.update({ where: { id: c.id }, data: { aiIcpFit: parsed.fit } });
          scored++;
        }
      } catch { /* skip this one; the loop can re-run the offset */ }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const nextOffset = offset + convs.length;
  return NextResponse.json(
    { scored, nextOffset, total, done: nextOffset >= total },
    { headers: CORS },
  );
}

export async function OPTIONS() { return optionsResponse(); }
