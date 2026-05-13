import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';

const CATEGORIES = [
  'cold-pitch',     // someone pitching the user (product, agency, recruiter pitch)
  'warm-lead',      // engaged prospect — replied positively, asked questions, etc.
  'client',         // existing/past customer / committed deal
  'recruiter',      // job opportunity / hiring outreach
  'intro',          // mutual intro / networking / referral
  'spam',           // obvious junk / blatant mass outreach
  'other',          // anything else
] as const;

type Category = (typeof CATEGORIES)[number];

// POST { conversationIds: string[] } → { results: Array<{ id, category, summary }> }
// Batches up to 25 conversations per call. Updates AppState rows directly.
export async function POST(req: NextRequest) {
  try {
    const { conversationIds, force } = await req.json();
    if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
      return NextResponse.json({ error: 'conversationIds required' }, { status: 400, headers: CORS });
    }

    const convs = await prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      include: { messages: { orderBy: { sentAt: 'asc' }, take: 8 } },
    });

    // Skip already-classified unless force=true
    const toRun = force
      ? convs
      : convs.filter((c) => !c.aiCategory || !c.aiSummary);

    if (toRun.length === 0) {
      return NextResponse.json({ results: [], skipped: convs.length }, { headers: CORS });
    }

    const state = await prisma.appState.findUnique({ where: { id: 1 } });
    const myName = state?.profileName ?? 'me';

    // Build a single batched prompt — one Claude call classifies all of them.
    const items = toRun.map((c, idx) => {
      let parts: Array<{ name?: string; headline?: string }> = [];
      try { parts = JSON.parse(c.participants); } catch {}
      const who = parts[0]?.name ?? 'Unknown';
      const role = parts[0]?.headline ?? '';
      const snippet = c.messages
        .map((m) => `${m.isFromMe ? myName : m.senderName}: ${m.body.trim().slice(0, 240)}`)
        .join('\n')
        .slice(0, 1200);
      return `## ITEM ${idx + 1}\nID: ${c.id}\nFrom: ${who}${role ? ` (${role})` : ''}\nTranscript:\n${snippet}`;
    }).join('\n\n');

    const systemPrompt = [
      `You classify LinkedIn conversations for ${myName}, a salesperson.`,
      '',
      `Categories: ${CATEGORIES.join(', ')}`,
      '',
      'Rules:',
      `• cold-pitch: someone is pitching ${myName} (their product/service). Mass-outreach feel.`,
      `• warm-lead: prospect ${myName} reached out to has engaged positively — replied, asked questions, expressed interest.`,
      `• client: an existing or past customer, or a committed deal in flight.`,
      `• recruiter: hiring/job outreach.`,
      `• intro: mutual introduction, networking referral, or warm intro from a connection.`,
      `• spam: obvious low-effort mass outreach or junk.`,
      `• other: doesn't clearly fit any of the above.`,
      '',
      'For each item also write a SUMMARY of ≤ 20 words capturing where the conversation stands and what action is open.',
    ].join('\n');

    const userPrompt = `${items}\n\nReturn ONLY a JSON array, one object per item, in order:
[{"id":"...","category":"cold-pitch","summary":"..."}, ...]
No prose, no markdown.`;

    const anthropic = await requireAnthropic();
    const response = await anthropic.messages.create({
      model: MODELS.fast,
      max_tokens: 2000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');

    // Robust JSON extraction — Claude usually returns clean JSON but be defensive
    let parsed: Array<{ id: string; category: string; summary: string }> = [];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
    } catch (e) {
      return NextResponse.json(
        { error: 'failed to parse Claude response', raw: text.slice(0, 500) },
        { status: 500, headers: CORS },
      );
    }

    // Persist results
    const now = new Date();
    for (const r of parsed) {
      const category: Category = (CATEGORIES as readonly string[]).includes(r.category) ? (r.category as Category) : 'other';
      await prisma.conversation.update({
        where: { id: r.id },
        data: {
          aiCategory: category,
          aiSummary: r.summary?.slice(0, 400) ?? null,
          aiUpdatedAt: now,
        },
      }).catch(() => {});
    }

    return NextResponse.json(
      { results: parsed, model: MODELS.fast, usage: response.usage },
      { headers: CORS },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    const status = msg.startsWith('NO_API_KEY') ? 401 : 500;
    return NextResponse.json({ error: msg }, { status, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
