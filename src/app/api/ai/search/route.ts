import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';

// POST { query: string } → { matches: string[] }
// Filters conversations by natural-language intent. MVP — no embeddings yet.
// Sends Claude a digest of every conv's name + aiSummary (or first message
// snippet if no summary) and asks which match. Caps at top 200 by recency to
// keep latency under ~5s and cost reasonable.
export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    if (typeof query !== 'string' || !query.trim()) {
      return NextResponse.json({ error: 'query required' }, { status: 400, headers: CORS });
    }

    // Take the most-recent 200 conversations. Older threads are unlikely to be
    // what the user is searching for "right now"; if we need more we can add
    // pagination later.
    const convs = await prisma.conversation.findMany({
      where: { status: { not: 'archived' } },
      orderBy: { lastMessageAt: 'desc' },
      take: 200,
      include: { messages: { orderBy: { sentAt: 'asc' }, take: 1 } },
    });

    const digest = convs.map((c, idx) => {
      let parts: Array<{ name?: string; headline?: string }> = [];
      try { parts = JSON.parse(c.participants); } catch {}
      const who = parts[0]?.name ?? 'Unknown';
      const role = parts[0]?.headline ?? '';
      const summary = c.aiSummary ?? c.lastMessage?.slice(0, 160) ?? '';
      return `${idx + 1}. ${who}${role ? ` (${role})` : ''}\n   ${summary}`;
    }).join('\n');

    const systemPrompt = [
      'You are a semantic filter over LinkedIn conversations.',
      'The user has a natural-language query. Return the indexes of conversations that match — not keyword overlap, but actual meaning.',
      'Be generous but not sloppy: include borderline matches, exclude clearly unrelated ones.',
      'Output ONLY a JSON array of integers (the 1-based item numbers). No prose.',
      'If nothing matches, return [].',
    ].join('\n');

    const userPrompt = `QUERY: ${query.trim()}\n\nITEMS:\n${digest}\n\nReturn matching item numbers as JSON array.`;

    const anthropic = await requireAnthropic();
    const response = await anthropic.messages.create({
      model: MODELS.fast,
      max_tokens: 1000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');

    let indexes: number[] = [];
    try {
      const match = text.match(/\[[\s\S]*?\]/);
      if (match) indexes = JSON.parse(match[0]);
    } catch {}

    const matches = indexes
      .map((i) => convs[i - 1]?.id)
      .filter(Boolean) as string[];

    return NextResponse.json(
      { matches, count: matches.length, scanned: convs.length, usage: response.usage },
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
