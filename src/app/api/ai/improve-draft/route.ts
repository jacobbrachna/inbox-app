import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';

// POST { conversationId, draft } → { suggestions: string[], improved: string | null }
// Claude reviews a draft against:
//   • The thread context (last 12 msgs)
//   • Your reply-rate baseline (so it can compare "messages like this got X%")
//   • Your past outbound messages from this same conv (style match)
// Returns 2-4 specific, actionable suggestions + one optionally-improved version.
export async function POST(req: NextRequest) {
  try {
    const { conversationId, draft } = await req.json();
    if (!conversationId || typeof draft !== 'string' || !draft.trim()) {
      return NextResponse.json({ error: 'conversationId and draft required' }, { status: 400, headers: CORS });
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { messages: { orderBy: { sentAt: 'asc' }, take: 50 } },
    });
    if (!conv) {
      return NextResponse.json({ error: 'conversation not found' }, { status: 404, headers: CORS });
    }

    const state = await prisma.appState.findUnique({ where: { id: 1 } });
    const styleNote = state?.aiStyleNote ?? '';
    const myName = state?.profileName ?? 'me';

    // Compute baseline reply rate from this user's overall history (cheap to query
    // each time; if it becomes a hotspot we can cache).
    const stats = await computeReplyBaseline();

    const recent = conv.messages.slice(-12);
    const transcript = recent
      .map((m) => `${m.isFromMe ? myName : m.senderName}: ${m.body.trim()}`)
      .join('\n\n');

    const systemPrompt = [
      `You critique LinkedIn message drafts for ${myName}, a sales/BD professional.`,
      `Your job is to give 2-4 SPECIFIC suggestions to improve their draft and the response rate.`,
      '',
      `Baseline data for ${myName}:`,
      `• Overall reply rate on outbound: ${(stats.replyRate * 100).toFixed(0)}% (n=${stats.sent})`,
      `• Avg outbound message length that got replies: ${stats.avgReplyingLength} chars`,
      `• Avg outbound length that got NO reply: ${stats.avgNonReplyingLength} chars`,
      '',
      'Suggestion rules:',
      '• Be SPECIFIC. "Shorten this" is useless. "Cut the second paragraph — that\'s where the prospect would lose focus" is useful.',
      '• Cite the baseline when relevant (e.g. "Your replied-to messages average 280 chars; this is 450").',
      '• If the draft is already strong, say so — don\'t invent problems.',
      '• Don\'t suggest emojis or corporate fluff.',
      styleNote ? `\nUser's style note: "${styleNote}"` : '',
    ].filter(Boolean).join('\n');

    const userPrompt = [
      'Recent thread (oldest first):',
      '---',
      transcript,
      '---',
      '',
      `Draft to improve:`,
      '---',
      draft.trim(),
      '---',
      '',
      'Return a JSON object:',
      '{',
      '  "suggestions": ["specific suggestion 1", "specific suggestion 2", ...],',
      '  "improved": "an improved version of the draft, OR null if it\'s already good"',
      '}',
      'No prose outside the JSON.',
    ].join('\n');

    const anthropic = await requireAnthropic();
    const response = await anthropic.messages.create({
      model: MODELS.draft,
      max_tokens: 1200,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');

    let parsed: { suggestions: string[]; improved: string | null } = { suggestions: [], improved: null };
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}

    return NextResponse.json({
      suggestions: parsed.suggestions ?? [],
      improved: parsed.improved ?? null,
      baseline: stats,
      usage: response.usage,
    }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    const status = msg.startsWith('NO_API_KEY') ? 401 : 500;
    return NextResponse.json({ error: msg }, { status, headers: CORS });
  }
}

// Cheap baseline of reply rate + length stats across the user's outbound
// history. Used to give Claude concrete numbers to cite.
async function computeReplyBaseline() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const REPLY_WINDOW = 14 * DAY_MS;
  const convs = await prisma.conversation.findMany({
    select: {
      messages: {
        select: { sentAt: true, isFromMe: true, body: true },
        orderBy: { sentAt: 'asc' },
      },
    },
  });
  let sent = 0;
  let replied = 0;
  let repliedLengthSum = 0;
  let unrepliedLengthSum = 0;
  for (const c of convs) {
    const msgs = c.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m.isFromMe) continue;
      sent++;
      const deadline = m.sentAt.getTime() + REPLY_WINDOW;
      let didReply = false;
      for (let j = i + 1; j < msgs.length; j++) {
        const n = msgs[j];
        if (n.sentAt.getTime() > deadline) break;
        if (!n.isFromMe) { didReply = true; break; }
      }
      if (didReply) {
        replied++;
        repliedLengthSum += m.body.length;
      } else {
        unrepliedLengthSum += m.body.length;
      }
    }
  }
  return {
    sent,
    replied,
    replyRate: sent > 0 ? replied / sent : 0,
    avgReplyingLength: replied > 0 ? Math.round(repliedLengthSum / replied) : 0,
    avgNonReplyingLength: sent - replied > 0 ? Math.round(unrepliedLengthSum / (sent - replied)) : 0,
  };
}

export async function OPTIONS() {
  return optionsResponse();
}
