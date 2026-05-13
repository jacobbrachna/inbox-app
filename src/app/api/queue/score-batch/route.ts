import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse, safeParseArray } from '@/lib/api-utils';
import { getAnthropic } from '@/lib/ai';
import type { Participant } from '@/types';

// POST { convIds: string[] } — score each conv by outbound-queue priority.
// Sends the last ~6 messages of each thread to Claude and gets back:
//   { priority: 0-100, signal: "Asked about pricing" }
// Result is cached on the Conversation row so we don't re-score on every Queue
// page-load. Re-score only when a conv has new activity since last score.

const PROMPT = `You score conversations for an SDR's "outbound queue" — which conversations should they work on TODAY.

For the given conversation, output JSON with:
- priority (0-100): how urgent is it that the SDR responds/follows up?
  - 90-100: explicit buying signal (asked about pricing, asked to schedule, expressed interest)
  - 70-89: asked a substantive question, mentioned a relevant deadline, requested info
  - 50-69: friendly reply, light engagement, worth nudging
  - 30-49: cold or formulaic reply, low intent
  - 0-29: not actionable (auto-responder, "not interested", off-topic)
- signal (max 60 chars): one short phrase describing WHY it ranks here.
  Examples: "Asked about pricing", "Mentioned Q1 launch", "Replied with interest",
  "Auto-reply only", "Said not interested".

Output ONLY a JSON object, no surrounding text. Example:
{"priority":85,"signal":"Asked when we can meet"}`;

interface ScoreResult {
  priority: number;
  signal: string;
}

function safeJsonParse(s: string): ScoreResult | null {
  try {
    const j = JSON.parse(s);
    if (typeof j?.priority === 'number' && typeof j?.signal === 'string') {
      return { priority: Math.max(0, Math.min(100, Math.round(j.priority))), signal: j.signal.slice(0, 80) };
    }
  } catch {}
  // Try to extract JSON from surrounding text
  const m = s.match(/\{[^}]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (typeof j?.priority === 'number' && typeof j?.signal === 'string') {
        return { priority: Math.max(0, Math.min(100, Math.round(j.priority))), signal: j.signal.slice(0, 80) };
      }
    } catch {}
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { convIds } = await req.json();
    if (!Array.isArray(convIds) || convIds.length === 0) {
      return NextResponse.json({ scored: 0 }, { headers: CORS });
    }

    const clientNullable = await getAnthropic();
    if (!clientNullable) {
      return NextResponse.json(
        { error: 'no_api_key', scored: 0 },
        { status: 400, headers: CORS },
      );
    }
    const client = clientNullable; // non-null reference for use inside worker closures

    // Cap batch size for safety
    const ids = convIds.slice(0, 50);
    const convs = await prisma.conversation.findMany({
      where: { id: { in: ids } },
      include: {
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 6,
        },
      },
    });

    let scored = 0;
    const results: Record<string, ScoreResult & { error?: string }> = {};

    // Run requests in parallel with a small concurrency limit
    const CONCURRENCY = 4;
    let idx = 0;
    async function worker() {
      while (idx < convs.length) {
        const my = idx++;
        const c = convs[my];
        if (c.messages.length === 0) continue;
        const parts = safeParseArray<Participant>(c.participants, []);
        const p = parts[0];
        // Build the convo text — oldest to newest, abbreviated
        const lines = c.messages.slice().reverse().map((m) => {
          const who = m.isFromMe ? 'Me' : (p?.name || 'Them');
          return `${who}: ${m.body.replace(/\s+/g, ' ').slice(0, 400)}`;
        });
        const userMsg = `Contact: ${p?.name ?? 'Unknown'}${p?.headline ? ` (${p.headline})` : ''}\n\nMessages:\n${lines.join('\n')}`;
        try {
          const resp = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 80,
            system: PROMPT,
            messages: [{ role: 'user', content: userMsg }],
          });
          const text = resp.content
            .map((b) => ('text' in b ? b.text : ''))
            .join('')
            .trim();
          const parsed = safeJsonParse(text);
          if (parsed) {
            await prisma.conversation.update({
              where: { id: c.id },
              data: {
                aiPriorityScore: parsed.priority,
                aiPrioritySignal: parsed.signal,
                aiPriorityAt: new Date(),
              },
            });
            results[c.id] = parsed;
            scored++;
          } else {
            results[c.id] = { priority: 0, signal: '', error: 'parse_failed' };
          }
        } catch (e) {
          results[c.id] = {
            priority: 0,
            signal: '',
            error: e instanceof Error ? e.message : 'unknown',
          };
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    return NextResponse.json(
      { scored, total: convs.length, results },
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
