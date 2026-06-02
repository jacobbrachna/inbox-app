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

const BASE_PROMPT = `You score conversations for an SDR's "outbound queue" — which conversations should they work on TODAY.

For the given conversation, output JSON with:
- priority (0-100): how urgent is it that the SDR responds/follows up?
  - 90-100: explicit buying signal (asked about pricing, asked to schedule, expressed interest)
  - 70-89: asked a substantive question, mentioned a relevant deadline, requested info
  - 50-69: friendly reply, light engagement, worth nudging
  - 30-49: cold or formulaic reply, low intent
  - 0-29: not actionable (auto-responder, "not interested", off-topic)
- icpFit (0-100): how well does the contact fit the SDR's Ideal Customer Profile?
  Score from the contact's role/headline/company against the ICP brief below.
  Be generous on close matches — "Director of Security" still fits "Head of Security",
  a fintech still fits "B2B SaaS" if the role aligns. Reserve <40 for true mismatches.
  If no ICP brief is provided, return 50 (neutral).
  - 80-100: strong fit (exact title family + relevant industry/size)
  - 60-79: close fit (similar title OR same industry, missing one dimension)
  - 40-59: partial fit (related role or adjacent industry)
  - 0-39: clear mismatch
- signal (max 60 chars): one short phrase describing WHY priority ranks where it does.
  Examples: "Asked about pricing", "Mentioned Q1 launch", "Replied with interest",
  "Auto-reply only", "Said not interested".

Output ONLY a JSON object, no surrounding text. Example:
{"priority":85,"icpFit":78,"signal":"Asked when we can meet"}`;

interface ScoreResult {
  priority: number;
  icpFit: number;
  signal: string;
}

function clamp(n: number) { return Math.max(0, Math.min(100, Math.round(n))); }

function safeJsonParse(s: string): ScoreResult | null {
  const tryParse = (raw: string): ScoreResult | null => {
    try {
      const j = JSON.parse(raw);
      if (typeof j?.priority === 'number' && typeof j?.signal === 'string') {
        return {
          priority: clamp(j.priority),
          // icpFit is new — default to 50 if older model output omits it.
          icpFit: typeof j.icpFit === 'number' ? clamp(j.icpFit) : 50,
          signal: j.signal.slice(0, 80),
        };
      }
    } catch {}
    return null;
  };
  const direct = tryParse(s);
  if (direct) return direct;
  const m = s.match(/\{[^}]*\}/);
  if (m) return tryParse(m[0]);
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

    // Pull state once per batch. If a structured icpDefinition exists, the
    // deterministic scorer in /api/icp/rescore owns icpFit — this batch only
    // computes priority + signal (urgency). Otherwise we fall back to the
    // free-text ICP brief and have Claude estimate icpFit too.
    const state = await prisma.appState.findUnique({ where: { id: 1 } });
    const hasStructuredIcp = !!state?.icpDefinition;
    const icpBrief = state?.idealCustomerProfile?.trim() || '';
    const SYSTEM = hasStructuredIcp
      ? `${BASE_PROMPT}\n\nICP fit is handled separately — return icpFit:50 (it will be overridden).`
      : icpBrief
        ? `${BASE_PROMPT}\n\nICP brief (the SDR's ideal customer):\n${icpBrief}`
        : `${BASE_PROMPT}\n\nICP brief: (none provided — return icpFit:50)`;

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
            max_tokens: 100,
            system: SYSTEM,
            messages: [{ role: 'user', content: userMsg }],
          });
          const text = resp.content
            .map((b) => ('text' in b ? b.text : ''))
            .join('')
            .trim();
          const parsed = safeJsonParse(text);
          if (parsed) {
            // Don't overwrite a deterministic icpFit when a structured ICP
            // definition is in play — that path owns the column.
            const data: Record<string, unknown> = {
              aiPriorityScore: parsed.priority,
              aiPrioritySignal: parsed.signal,
              aiPriorityAt: new Date(),
            };
            if (!hasStructuredIcp) data.aiIcpFit = parsed.icpFit;
            await prisma.conversation.update({ where: { id: c.id }, data });
            results[c.id] = parsed;
            scored++;
          } else {
            results[c.id] = { priority: 0, icpFit: 50, signal: '', error: 'parse_failed' };
          }
        } catch (e) {
          results[c.id] = {
            priority: 0,
            icpFit: 50,
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
