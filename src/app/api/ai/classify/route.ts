import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';
import { resolveFuzzyDate } from '@/lib/fuzzy-date';
import { loadAIManagedLabels, applyExclusiveGroups } from '@/lib/ai-labels';
import { createNotification } from '@/lib/notify';
import { safeParseArray } from '@/lib/api-utils';

// Labels that warrant a desktop ping when AI auto-applies them — these
// represent genuine pipeline progress (interested prospects, meetings, etc).
const HIGH_SIGNAL_LABEL_IDS = new Set([
  'ai-interested',       // Showed interest
  'ai-meeting-booked',   // Meeting booked
  'ai-meeting-done',     // Meeting done
]);

// Pull a display name from the conversation's participants JSON (first
// participant). Falls back to 'Contact' if unparseable.
function displayName(participantsJson: string | null | undefined): string {
  const parts = safeParseArray<{ name?: string }>(participantsJson ?? '[]', []);
  return parts[0]?.name ?? 'Contact';
}

const REVIEW_QUEUE_CAP = 30;
const ACTIVE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// POST { conversationIds: string[] } → { results: Array<{ id, summary, labels, followUp }> }
// Batches up to 25 conversations per call. Updates Conversation rows directly.
export async function POST(req: NextRequest) {
  try {
    const { conversationIds, force } = await req.json();
    if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
      return NextResponse.json({ error: 'conversationIds required' }, { status: 400, headers: CORS });
    }

    const convs = await prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      include: {
        messages: { orderBy: { sentAt: 'asc' }, take: 8 },
        // Authoritative inbound count — drives the origin-label guard below.
        _count: { select: { messages: { where: { isFromMe: false } } } },
      },
    });

    // Skip already-classified unless force=true. aiSummary IS NULL is the
    // marker for "never classified."
    const toRun = force
      ? convs
      : convs.filter((c) => !c.aiSummary);

    if (toRun.length === 0) {
      return NextResponse.json({ results: [], skipped: convs.length }, { headers: CORS });
    }

    const state = await prisma.appState.findUnique({ where: { id: 1 } });
    const myName = state?.profileName ?? 'me';

    // Load the AI-managed labels (system seeds + user-created with descriptions)
    const aiLabels = await loadAIManagedLabels();
    const labelById = new Map(aiLabels.map((l) => [l.id, l]));

    // Current size of the review queue — used to cap new ambiguous flags
    const currentReviewCount = await prisma.conversation.count({ where: { needsReview: true } });
    const reviewSlotsLeft = Math.max(0, REVIEW_QUEUE_CAP - currentReviewCount);

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

    const todayIso = new Date().toISOString().slice(0, 10);

    // Build the labels section of the prompt: id, name, description, group.
    // Group constraints are spelled out so Claude doesn't propose conflicting labels.
    const labelsBlock = aiLabels.length === 0 ? '' : [
      '',
      'LABELS — apply ONLY labels that clearly fit. Empty array is a valid, encouraged answer when no label genuinely applies. Do NOT force a fit:',
      ...aiLabels.map((l) => {
        const grp = l.exclusiveGroup ? `  [group: ${l.exclusiveGroup}]` : '';
        return `• ${l.id} — ${l.name}${grp}: ${l.description}`;
      }),
      '',
      'GROUPS are mutually exclusive — within one group, pick AT MOST ONE label (the most current state).',
      `Multiple labels from DIFFERENT groups (or ungrouped labels) can co-exist and often should — e.g., a recruiter conversation that's gone silent gets both "Recruiter" and "Ghosted".`,
      `IMPORTANT: Origin labels (group "origin": Recruiter / Sales pitch / Mutual intro) describe the OTHER party's outreach TO ${myName}. Do NOT apply an origin label when the conversation has only messages FROM ${myName} — those are ${myName}'s own outreach, not someone pitching them.`,
      `When nothing fits, return labels: []. Many conversations legitimately have no applicable label and that is fine.`,
    ].join('\n');

    // Pull recent user-flagged false-positive follow-up phrases so the
    // classifier can avoid re-triggering on similar wording. Last 90 days,
    // cap at 25 — enough signal without bloating the prompt.
    const feedbackRows = await prisma.followUpFeedback.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { phrase: true },
    });
    const feedbackHints = feedbackRows.length > 0
      ? feedbackRows.map((f) => `  • "${f.phrase.slice(0, 140)}"`).join('\n')
      : null;

    const systemPrompt = [
      `You classify LinkedIn conversations for ${myName}, a salesperson.`,
      `Today's date: ${todayIso}`,
      '',
      `For each item write a SUMMARY of ≤ 20 words capturing where the conversation stands and what action is open.`,
      '',
      `========================================`,
      `FOLLOW-UP DETECTION — be strict, this drives the user's calendar.`,
      `========================================`,
      ``,
      `Output a "followUp" object ONLY when the conversation contains a real time-anchored COMMITMENT or SOFT signal. Otherwise return followUp: null.`,
      ``,
      `Three categories:`,
      ``,
      `1. "commitment" — fires desktop notifications. ALL of these must hold:`,
      `   • Has explicit OR clearly-anchored timing (date, event, "next week", "in 3 weeks", "before Friday", "after the Q1 board meeting", "ping me Monday")`,
      `   • Has commitment intent — someone is going to DO something (send, schedule, reconnect, follow up)`,
      `   • The intent is BOUND to the timing (not a vague "happy to chat sometime")`,
      `   Examples to fire as commitment:`,
      `     ✓ "I'll send the deck by Friday" → self`,
      `     ✓ "Let's reconnect Oct 15" → either`,
      `     ✓ "Ping me in 3 weeks" → self (recipient wants user to ping)`,
      `     ✓ "Let's talk after Black Hat" → either (event-anchored)`,
      `     ✓ "Schedule a call for next Tuesday" → either`,
      `     ✓ "I'll get back to you Monday" → them`,
      ``,
      `2. "soft" — surfaces in tasks/bell, does NOT fire desktop notifications.`,
      `   Time-direction is present but the intent is hedged or weak:`,
      `   Examples to mark soft:`,
      `     ◦ "Reach back out in a few weeks"`,
      `     ◦ "Maybe we can sync next month"`,
      `     ◦ "Catch you at the next conference"`,
      `     ◦ "Let me think on it and circle back"`,
      ``,
      `3. "none" — return followUp: null. DO NOT fire. These are NOT follow-ups:`,
      `   ✗ "Happy to chat down the road if relevant" — conditional, no commitment`,
      `   ✗ "If AI becomes a focus area, let's compare notes" — conditional`,
      `   ✗ "In the future when it comes up" — vague brush-off`,
      `   ✗ "Not the right time" — explicit rejection`,
      `   ✗ "Down the line" / "someday" / "eventually" — no timing anchor`,
      `   ✗ "Stay in touch" / "let's keep in touch" — pleasantry`,
      `   ✗ "Thanks for reaching out" — closing, not a commitment`,
      `   ✗ Past-tense references ("I followed up last week") — already happened`,
      ``,
      `Fields when followUp is non-null:`,
      `   • phrase: EXACT quote (≤200 chars) from the transcript that triggered the detection. This is what the user will see.`,
      `   • date: ISO YYYY-MM-DD. ALWAYS in the future (> today). For "next week" use today+7. For relative ranges pick a sensible midpoint ("in a few weeks" → today+18). For event-anchored, use the event date if known.`,
      `   • kind: "commitment" or "soft" per the rules above.`,
      `   • actor: "self" (${myName} committed) | "them" (the other party committed) | "either" (mutual / unclear).`,
      feedbackHints ? `\nThe USER has previously flagged these phrases as false positives — do NOT re-trigger follow-ups on similar wording:\n${feedbackHints}` : '',
      ``,
      `========================================`,
      ``,
      labelsBlock,
      '',
      `If you see signal in the conversation but you're NOT confident which label group applies (e.g., torn between two labels in the same group, or you see meaningful content that doesn't cleanly match any label), set needsReview=true with a short reason. Don't set needsReview when there's simply nothing to label — only when you'd want a human to decide. Be conservative: most conversations should NOT need review.`,
      '',
      `OUTBOUND-QUEUE PRIORITY — also score each item 0-100 for how urgently ${myName} should act on it TODAY:`,
      `• 90-100: explicit buying signal (asked about pricing, asked to schedule, expressed interest in next step)`,
      `• 70-89: substantive question, mentioned a relevant deadline, requested info`,
      `• 50-69: friendly reply, light engagement, worth nudging`,
      `• 30-49: cold or formulaic reply, low intent`,
      `• 0-29: not actionable (auto-responder, "not interested", off-topic, no inbound)`,
      `Also give a short "signal" (max 60 chars) — one phrase describing WHY it ranks where it does. Examples: "Asked about pricing", "Mentioned Q1 launch", "Replied with interest", "Auto-reply only", "Said not interested".`,
    ].join('\n');

    const userPrompt = `${items}\n\nReturn ONLY a JSON array, one object per item, in order:
[{"id":"...","summary":"...","followUp":{"phrase":"...","date":"2026-09-01","kind":"commitment","actor":"self"},"labels":["ai-recruiter","ai-question-pending"],"needsReview":false,"reviewReason":null,"priority":75,"signal":"Asked about pricing"}, ...]
Set "followUp" to null when none of the rules above apply. "labels" is an array of label ids (empty array is fine). "needsReview" is a boolean; "reviewReason" is a short string or null. "priority" is 0-100; "signal" is a short phrase.
No prose, no markdown.`;

    const anthropic = await requireAnthropic();
    const response = await anthropic.messages.create({
      model: MODELS.fast,
      // Each result row carries category + summary + followUp + labels[] +
      // needsReview + reason. For a batch of 25 convs that can run 3-4k
      // output tokens. 8000 leaves comfortable headroom.
      max_tokens: 8000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');

    // Robust JSON extraction — Claude usually returns clean JSON but be defensive
    interface FollowUpJson {
      phrase?: string;
      date?: string;
      // New shape: kind/actor. Legacy 'confidence' kept for tolerance during
      // prompt-cache warmup but no longer authoritative.
      kind?: 'commitment' | 'soft' | 'none';
      actor?: 'self' | 'them' | 'either';
      confidence?: string;
    }
    interface ResultRow {
      id: string;
      summary: string;
      followUp?: FollowUpJson | null;
      labels?: string[];
      needsReview?: boolean;
      reviewReason?: string | null;
      priority?: number;
      signal?: string;
    }
    let parsed: ResultRow[] = [];
    let parseError: string | null = null;
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]);
      else parseError = 'no JSON array found in response';
    } catch (e) {
      parseError = e instanceof Error ? e.message : 'parse error';
    }
    if (parseError || parsed.length === 0) {
      return NextResponse.json(
        {
          error: 'failed to parse Claude response',
          detail: parseError,
          stopReason: response.stop_reason,
          rawTail: text.slice(-400),
          rawHead: text.slice(0, 400),
          batchSize: toRun.length,
        },
        { status: 500, headers: CORS },
      );
    }

    // Index existing conversations so we can respect manual follow-up choices
    const existingById = new Map(toRun.map((c) => [c.id, c]));

    // Persist results
    const now = new Date();
    let followUpsSet = 0;
    let labelsApplied = 0;
    let reviewFlagged = 0;
    let reviewSlotsRemaining = reviewSlotsLeft;
    for (const r of parsed) {
      // Process follow-up: only proceed when AI emits a non-null followUp
      // object with kind in {'commitment', 'soft'}. 'none' or missing kind
      // is dropped entirely — this is the discipline that kills the noise.
      let followUpAt: Date | null = null;
      let followUpReason: string | null = null;
      let followUpConfidence: string | null = null;
      let followUpKind: 'commitment' | 'soft' | null = null;
      let followUpActor: 'self' | 'them' | 'either' | null = null;
      if (
        r.followUp &&
        typeof r.followUp === 'object' &&
        r.followUp.phrase &&
        (r.followUp.kind === 'commitment' || r.followUp.kind === 'soft')
      ) {
        const phrase = r.followUp.phrase.slice(0, 240);
        let date: Date | null = null;
        if (r.followUp.date) {
          const d = new Date(r.followUp.date);
          if (!isNaN(d.getTime()) && d.getTime() > now.getTime()) date = d;
        }
        if (!date) {
          const resolved = resolveFuzzyDate(phrase, now);
          if (resolved) date = resolved.date;
        }
        if (date) {
          followUpAt = date;
          followUpReason = phrase;
          followUpKind = r.followUp.kind;
          followUpActor = (r.followUp.actor === 'self' || r.followUp.actor === 'them' || r.followUp.actor === 'either')
            ? r.followUp.actor : null;
          // Map back to confidence column for backward compat. commitment
          // → high, soft → low. Old desktop-notification gate becomes
          // followUpKind === 'commitment' (see page.tsx).
          followUpConfidence = followUpKind === 'commitment' ? 'high' : 'low';
        }
      }

      // Never overwrite a manually-set follow-up
      const existing = existingById.get(r.id);
      const isManual = existing?.followUpSource === 'manual';
      const writeFollowUp = followUpAt && !isManual;
      if (writeFollowUp) followUpsSet++;

      // Resolve AI-proposed labels: keep only valid ones, then apply
      // mutex groups (within a group, keep the first proposed).
      let nextLabels: string[] | null = null;
      if (Array.isArray(r.labels) && r.labels.length > 0) {
        const valid = r.labels
          .map((id) => labelById.get(id))
          .filter((l): l is NonNullable<typeof l> => !!l);
        // Origin guard: when conv has zero inbound messages, an origin
        // label can't apply — someone has to actually be pitching us.
        const inboundCount = existing?._count?.messages ?? 0;
        const filtered = inboundCount === 0
          ? valid.filter((l) => l.exclusiveGroup !== 'origin')
          : valid;
        const deconflicted = applyExclusiveGroups(filtered);
        nextLabels = deconflicted.map((l) => l.id);
      } else if (Array.isArray(r.labels)) {
        // Empty array → AI explicitly says "no labels"
        nextLabels = [];
      }

      // Decide needsReview: only flag when conv is ACTIVE (recent activity),
      // not spam, queue has slots left, and AI explicitly requested review.
      let setNeedsReview = false;
      if (r.needsReview === true && reviewSlotsRemaining > 0) {
        const lastMs = existing?.lastMessageAt?.getTime() ?? 0;
        const ageMs = now.getTime() - lastMs;
        const isActive = ageMs < ACTIVE_DAYS * DAY_MS;
        if (isActive) {
          setNeedsReview = true;
          reviewSlotsRemaining--;
          reviewFlagged++;
        }
      }

      // Merge AI labels with existing user-added ones: replace AI-managed
      // labels entirely with the new set, keep user-added (aiManaged=false)
      // labels intact. Legacy regex-applied "auto-*" labels are deprecated
      // when AI is in charge — strip them so we don't double-tag.
      let labelsPatch: { labels: string } | Record<string, never> = {};
      if (nextLabels !== null) {
        let currentLabels: string[] = [];
        try { currentLabels = JSON.parse(existing?.labels ?? '[]'); } catch {}
        const keepUserLabels = currentLabels.filter((id) => {
          if (labelById.has(id)) return false; // AI-managed → replace
          if (id.startsWith('auto-')) return false; // legacy regex → drop
          return true;
        });
        const finalLabels = Array.from(new Set([...keepUserLabels, ...nextLabels]));
        labelsPatch = { labels: JSON.stringify(finalLabels) };
        labelsApplied += nextLabels.length;
      }

      // Outbound-queue priority score — single source of truth in classify
      // now (was a separate /api/queue/score-batch pass historically).
      let priorityPatch: { aiPriorityScore: number; aiPrioritySignal: string | null; aiPriorityAt: Date } | Record<string, never> = {};
      if (typeof r.priority === 'number') {
        priorityPatch = {
          aiPriorityScore: Math.max(0, Math.min(100, Math.round(r.priority))),
          aiPrioritySignal: typeof r.signal === 'string' ? r.signal.slice(0, 80) : null,
          aiPriorityAt: now,
        };
      }

      // Notification: fire on AI-applied high-signal labels that are NEW
      // to this conversation. Skip if the label was already present (the
      // user was already aware of the signal).
      if (nextLabels) {
        let previousLabels: string[] = [];
        try { previousLabels = JSON.parse(existing?.labels ?? '[]'); } catch {}
        const justAddedHighSignal = nextLabels.filter((id) =>
          HIGH_SIGNAL_LABEL_IDS.has(id) && !previousLabels.includes(id),
        );
        for (const labelId of justAddedHighSignal) {
          const labelName = labelById.get(labelId)?.name ?? labelId;
          await createNotification({
            kind: 'ai-signal',
            title: `${labelName} — ${displayName(existing?.participants)}`,
            body: r.signal || r.summary?.slice(0, 140) || 'AI flagged a positive signal',
            conversationId: r.id,
            meta: { labelId, labelName },
          });
        }
      }

      await prisma.conversation.update({
        where: { id: r.id },
        data: {
          aiSummary: r.summary?.slice(0, 400) ?? null,
          ...priorityPatch,
          aiUpdatedAt: now,
          needsReview: setNeedsReview,
          ...labelsPatch,
          ...(writeFollowUp ? {
            followUpAt,
            followUpReason,
            followUpSource: 'ai',
            followUpConfidence,
            followUpKind,
            followUpActor,
          } : {}),
        },
      }).catch(() => {});
    }

    return NextResponse.json(
      {
        results: parsed,
        followUpsSet,
        labelsApplied,
        reviewFlagged,
        reviewSlotsLeftAfter: reviewSlotsRemaining,
        model: MODELS.fast,
        usage: response.usage,
      },
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
