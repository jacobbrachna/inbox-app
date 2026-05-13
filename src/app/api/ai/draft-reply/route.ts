import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';

// POST { conversationId } → { drafts: string[] }
// Generates 2–3 candidate replies grounded in:
//   • The thread's recent messages (last 12)
//   • The user's saved style note (from Settings)
//   • Up to 6 of the user's recent outbound messages in this conv (style sample)
export async function POST(req: NextRequest) {
  try {
    const { conversationId } = await req.json();
    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId required' }, { status: 400, headers: CORS });
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: { orderBy: { sentAt: 'asc' }, take: 50 },
      },
    });
    if (!conv) {
      return NextResponse.json({ error: 'conversation not found' }, { status: 404, headers: CORS });
    }

    const state = await prisma.appState.findUnique({ where: { id: 1 } });
    const styleNote = state?.aiStyleNote ?? '';
    const myName = state?.profileName ?? 'me';

    // Last 12 messages for thread context (most recent at bottom)
    const recent = conv.messages.slice(-12);
    const transcript = recent
      .map((m) => `${m.isFromMe ? myName : m.senderName}: ${m.body.trim()}`)
      .join('\n\n');

    // Up to 6 of the user's recent outbound messages — Claude uses these as
    // style samples to match the user's voice across drafts.
    const myMessages = conv.messages
      .filter((m) => m.isFromMe)
      .slice(-6)
      .map((m) => m.body.trim());

    let participants: Array<{ name?: string; headline?: string }> = [];
    try { participants = JSON.parse(conv.participants); } catch {}
    const otherPersonName = participants[0]?.name ?? 'them';
    const otherPersonRole = participants[0]?.headline ?? '';

    const systemPrompt = [
      `You are drafting LinkedIn reply messages for ${myName}, a sales/business-development professional.`,
      otherPersonRole ? `The conversation is with ${otherPersonName} (${otherPersonRole}).` : `The conversation is with ${otherPersonName}.`,
      '',
      'Hard rules:',
      '• Match the user\'s tone exactly — refer to their style samples below.',
      '• Stay short. LinkedIn replies should rarely exceed 4-6 lines.',
      '• Never sound generic or AI-written. No corporate platitudes.',
      '• Skip greetings if the thread is already mid-conversation (no "Hi X," on a 5th-message reply).',
      '• Don\'t invent facts. If you need info you don\'t have, leave a [bracket placeholder].',
      styleNote ? `\nUser's style note (verbatim, follow this):\n"${styleNote}"` : '',
      myMessages.length > 0
        ? `\nThe user's own recent messages in this thread (match their voice):\n${myMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n');

    const userPrompt = [
      'Here is the recent thread (oldest first):',
      '---',
      transcript,
      '---',
      '',
      'Write 3 distinct draft replies for the user to send next. Vary the angle:',
      '• Draft 1 — direct / confident',
      '• Draft 2 — warmer / curious',
      '• Draft 3 — short and casual (1-2 lines)',
      '',
      'Output ONLY the three drafts, separated by the line `---`. No preamble, no labels, no quotes.',
    ].join('\n');

    const anthropic = await requireAnthropic();
    const response = await anthropic.messages.create({
      model: MODELS.draft,
      max_tokens: 800,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');

    const drafts = text
      .split(/\n---+\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);

    return NextResponse.json(
      { drafts, model: MODELS.draft, usage: response.usage },
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
