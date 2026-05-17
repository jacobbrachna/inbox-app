import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';
import {
  buildContactContextBlock,
  buildSenderContextBlock,
  buildDocsContextBlock,
  CONTACT_CONTEXT_SELECT,
} from '@/lib/contact-context';

// POST { conversationId } → { drafts: string[] }
// Generates 2–3 candidate replies grounded in:
//   • The thread's recent messages (last 12)
//   • The user's saved style note (from Settings)
//   • Up to 6 of the user's recent outbound messages in this conv (style sample)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const conversationId = body?.conversationId;
    // Free-form extra context the user typed (e.g. "we met in June",
    // "already have a meeting booked Aug 12"). Optional. Capped to keep
    // prompt size sane.
    const extraContext = typeof body?.extraContext === 'string'
      ? body.extraContext.trim().slice(0, 1200)
      : '';
    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId required' }, { status: 400, headers: CORS });
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: { orderBy: { sentAt: 'asc' }, take: 50 },
        contacts: {
          select: { contact: { select: CONTACT_CONTEXT_SELECT } },
          take: 1,
        },
      },
    });
    if (!conv) {
      return NextResponse.json({ error: 'conversation not found' }, { status: 404, headers: CORS });
    }

    const state = await prisma.appState.findUnique({ where: { id: 1 } });
    const styleNote = state?.aiStyleNote ?? '';
    const myName = state?.profileName ?? 'me';

    const docs = await prisma.document.findMany({
      where: { includeByDefault: true },
      select: { title: true, kind: true, summary: true },
    });
    const senderBlock = buildSenderContextBlock(state);
    const docsBlock = buildDocsContextBlock(docs);

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

    const contact = conv.contacts[0]?.contact ?? null;
    const contextBlock = buildContactContextBlock(contact, otherPersonName);

    // Inventory of what actually informed this draft — surfaced in the UI
    // so the user can see "Used: About, 3 prior roles, 5 posts, ICP brief"
    // and know whether to refresh the profile first.
    const contextUsed: string[] = [];
    if (contact?.about) contextUsed.push('About');
    try {
      const prev = contact?.prevRoles ? JSON.parse(contact.prevRoles) : null;
      if (Array.isArray(prev) && prev.length > 0) contextUsed.push(`${prev.length} prior role${prev.length === 1 ? '' : 's'}`);
    } catch {}
    try {
      const posts = contact?.recentPosts ? JSON.parse(contact.recentPosts) : null;
      if (Array.isArray(posts) && posts.length > 0) contextUsed.push(`${posts.length} recent post${posts.length === 1 ? '' : 's'}`);
    } catch {}
    try {
      const skills = contact?.skills ? JSON.parse(contact.skills) : null;
      if (Array.isArray(skills) && skills.length > 0) contextUsed.push('skills');
    } catch {}
    if (docs.length > 0) {
      const titles = docs.map((d) => d.title);
      contextUsed.push(...titles.slice(0, 3));
      if (titles.length > 3) contextUsed.push(`+${titles.length - 3} more`);
    }
    // "thin" = nothing personalized about this contact (no about/posts/roles)
    // even if we have docs + sender context. That's the case to flag.
    const contactSignals = [contact?.about, contact?.prevRoles, contact?.recentPosts].filter(Boolean).length;
    const readiness: 'thin' | 'some' | 'strong' = contactSignals === 0 ? 'thin' : contactSignals === 1 ? 'some' : 'strong';

    const systemPrompt = [
      `You are drafting LinkedIn reply messages for ${myName}, a sales/business-development professional.`,
      otherPersonRole ? `The conversation is with ${otherPersonName} (${otherPersonRole}).` : `The conversation is with ${otherPersonName}.`,
      '',
      'Hard rules:',
      '• Match the user\'s tone exactly — refer to their style samples below.',
      '• Stay short. LinkedIn replies should rarely exceed 4-6 lines.',
      '• Never sound generic or AI-written. No corporate platitudes.',
      '• Skip greetings if the thread is already mid-conversation (no "Hi X," on a 5th-message reply).',
      '• Don\'t invent facts or stats. If a number/claim isn\'t in the sender/reference context below, don\'t use it.',
      '• If you need info you don\'t have, leave a [bracket placeholder].',
      styleNote ? `\nUser's style note (verbatim, follow this):\n"${styleNote}"` : '',
      myMessages.length > 0
        ? `\nThe user's own recent messages in this thread (match their voice):\n${myMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
        : '',
      senderBlock,
      docsBlock,
      contextBlock,
      // User-supplied ad-hoc context for this specific draft. Highest
      // priority — it reflects facts the user knows about the relationship
      // that aren't captured in the thread or stored contact data.
      extraContext ? `\nAdditional context from ${myName} for THIS draft (treat as authoritative — they know the relationship better than the transcript):\n${extraContext}` : '',
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

    const candidates = text
      .split(/\n---+\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);

    // Self-critique pass — Haiku scores Sonnet's candidates against the
    // same patterns + context, returns top 2. Saves the user from sifting
    // through a weak option. Skipped if we only got 1-2 candidates (nothing
    // to filter) or the critique call fails (just return all candidates).
    let drafts = candidates;
    let critiqueUsage: unknown = null;
    let cutDraft: { text: string; reason: string } | null = null;

    if (candidates.length >= 3) {
      try {
        const critiquePrompt = [
          'You are scoring 3 candidate draft replies against the sender/recipient/reference context above. Pick the strongest 2 and identify the weakest to cut.',
          '',
          'Score each on:',
          '• Personalization — does it reference something specific from the recipient or thread context, not generic?',
          '• Voice match — does it sound like the user (per style samples + style note)?',
          '• Length fit — appropriate for LinkedIn (rarely >4-6 lines)?',
          '• Grounding — claims/numbers only used if present in context, no fabrication?',
          '• Pattern fit — if Winning Patterns are present in the context, does this match what works?',
          '',
          'Output ONLY this JSON, no preamble:',
          '{"keep":[{"i":0,"score":N,"why":"one-liner"},{"i":1,"score":N,"why":"one-liner"}],"cut":{"i":N,"why":"one-liner"}}',
          'Where i is the candidate index (0-2).',
          '',
          'Candidates:',
          candidates.map((c, i) => `[${i}] ${c}`).join('\n\n'),
        ].join('\n');

        const critique = await anthropic.messages.create({
          model: MODELS.fast,
          max_tokens: 500,
          // Same system block — reuse the cache hit from above.
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: critiquePrompt }],
        });
        critiqueUsage = critique.usage;

        const cText = critique.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('\n');
        const jm = cText.match(/\{[\s\S]*\}/);
        if (jm) {
          const parsed = JSON.parse(jm[0]) as {
            keep: Array<{ i: number; score: number; why: string }>;
            cut?: { i: number; why: string };
          };
          if (Array.isArray(parsed.keep) && parsed.keep.length > 0) {
            // Sort by score desc, take top 2, map back to draft text.
            const top = parsed.keep
              .filter((k) => typeof k.i === 'number' && candidates[k.i] !== undefined)
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
              .slice(0, 2)
              .map((k) => candidates[k.i]);
            if (top.length > 0) drafts = top;
            if (parsed.cut && typeof parsed.cut.i === 'number' && candidates[parsed.cut.i]) {
              cutDraft = { text: candidates[parsed.cut.i], reason: parsed.cut.why ?? '' };
            }
          }
        }
      } catch {
        // Self-critique failed — fall back to all candidates. Non-fatal.
      }
    }

    return NextResponse.json(
      { drafts, cutDraft, contextUsed, readiness, model: MODELS.draft, usage: response.usage, critiqueUsage },
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
