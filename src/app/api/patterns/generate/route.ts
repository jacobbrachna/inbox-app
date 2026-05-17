import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';

// Phase 4 — outcome-aware pattern extraction.
// Reads the user's recent outbound messages, classifies each as WIN / DUD
// using the existing AI label state on the parent Conversation, sends the
// labeled corpus to Sonnet, and stores the resulting playbook as a
// Document with kind: "winning-patterns".
//
// Privacy guard: the prompt forbids quoting actual message text or naming
// specific contacts — the doc must be safe to share with teammates.

const SAMPLE_TARGET = 150;
const REPLY_WINDOW_DAYS = 14;

// LinkedIn dates from the SDUI parser: "May 2024", "2024", "Jan 2026", etc.
// Convert to a JS Date set to day 1. Returns null if unparseable.
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
function parseLinkedInDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const s2 = s.trim().toLowerCase();
  const monthYear = s2.match(/^([a-z]{3})[a-z]*\s+(\d{4})$/);
  if (monthYear) {
    const m = MONTHS[monthYear[1]];
    if (m !== undefined) return new Date(parseInt(monthYear[2], 10), m, 1);
  }
  const yearOnly = s2.match(/^(\d{4})$/);
  if (yearOnly) return new Date(parseInt(yearOnly[1], 10), 0, 1);
  return null;
}

type EmploymentEntry = { role?: string | null; company?: string | null; from?: string | null; to?: string | null };

function findCurrentRoleStart(history: EmploymentEntry[]): { start: Date | null; entry: EmploymentEntry | null } {
  // "Current" = entry with to === null or "present". Multiple current roles
  // possible (board seats etc.) — prefer the one with the most recent `from`.
  const current = history.filter((e) => e.to === null || (typeof e.to === 'string' && /present/i.test(e.to)));
  if (current.length === 0) return { start: null, entry: null };
  let best = current[0];
  let bestStart = parseLinkedInDate(best.from);
  for (const e of current.slice(1)) {
    const d = parseLinkedInDate(e.from);
    if (d && (!bestStart || d > bestStart)) { best = e; bestStart = d; }
  }
  return { start: bestStart, entry: best };
}

// Stable IDs from the seeded AI labels (see schema/labels seed).
const POSITIVE_LABEL_IDS = new Set([
  'ai-interested',       // Showed interest
  'ai-meeting-booked',
  'ai-meeting-done',
]);
const NEGATIVE_LABEL_IDS = new Set([
  'ai-ghosted',
  'not-interested',
]);

type Outcome = 'WIN' | 'DUD' | 'NEUTRAL';

function classify(gotReply: boolean, sentAt: Date, convLabelIds: string[]): Outcome {
  const hasPositive = convLabelIds.some((id) => POSITIVE_LABEL_IDS.has(id));
  const hasNegative = convLabelIds.some((id) => NEGATIVE_LABEL_IDS.has(id));
  if (gotReply && hasPositive) return 'WIN';
  if (hasNegative) return 'DUD';
  if (!gotReply) {
    const daysOld = (Date.now() - sentAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld >= REPLY_WINDOW_DAYS) return 'DUD';
  }
  return 'NEUTRAL';
}

export async function POST() {
  try {
    const state = await prisma.appState.findUnique({ where: { id: 1 } });
    const authorName = state?.profileName?.trim() || 'You';
    const authorRole = state?.myRole?.trim() || '';
    const authorCompany = state?.myCompany?.trim() || '';

    // If the user has their LinkedIn employment history populated, filter
    // the message corpus to "since the current role's start date" so we
    // don't mix patterns across employers. Falls back to all-time when no
    // history is available.
    let history: EmploymentEntry[] = [];
    try { history = state?.myEmploymentHistory ? JSON.parse(state.myEmploymentHistory) : []; } catch {}
    const { start: currentRoleStart, entry: currentEntry } = findCurrentRoleStart(history);
    const messageWhere: { isFromMe: boolean; sentAt?: { gte: Date } } = { isFromMe: true };
    if (currentRoleStart) messageWhere.sentAt = { gte: currentRoleStart };

    // Pull a generous candidate pool — we'll narrow to WIN/DUD after
    // classification, so over-sample to make sure we have enough signal.
    const candidates = await prisma.message.findMany({
      where: messageWhere,
      orderBy: { sentAt: 'desc' },
      take: SAMPLE_TARGET * 3,
      select: {
        id: true,
        body: true,
        sentAt: true,
        gotReply: true,
        daysToReply: true,
        conversationId: true,
      },
    });

    // Batch-load conversation labels for all candidate convs. Conversation.labels
    // is a JSON-encoded string[] of label IDs.
    const convIds = [...new Set(candidates.map((m) => m.conversationId))];
    const labelsByConv = new Map<string, string[]>();
    const CHUNK = 200;
    for (let i = 0; i < convIds.length; i += CHUNK) {
      const slice = convIds.slice(i, i + CHUNK);
      const rows = await prisma.conversation.findMany({
        where: { id: { in: slice } },
        select: { id: true, labels: true },
      });
      for (const r of rows) {
        try { labelsByConv.set(r.id, JSON.parse(r.labels) as string[]); } catch { labelsByConv.set(r.id, []); }
      }
    }

    // Classify and collect.
    const wins: typeof candidates = [];
    const duds: typeof candidates = [];
    for (const m of candidates) {
      const ids = labelsByConv.get(m.conversationId) ?? [];
      const c = classify(m.gotReply, m.sentAt, ids);
      if (c === 'WIN' && wins.length < SAMPLE_TARGET) wins.push(m);
      else if (c === 'DUD' && duds.length < SAMPLE_TARGET) duds.push(m);
      if (wins.length >= SAMPLE_TARGET && duds.length >= SAMPLE_TARGET) break;
    }

    if (wins.length + duds.length < 20) {
      return NextResponse.json({
        error: `Not enough labeled outcome data yet (${wins.length} wins, ${duds.length} duds). Need at least 20 total — keep sending and re-classifying conversations.`,
      }, { status: 400, headers: CORS });
    }

    // Build the prompt corpus. Numbered + length-tagged so Claude can spot
    // structural patterns without us pre-computing them.
    const formatMsg = (m: typeof candidates[number], i: number) =>
      `[${i + 1}] (len=${m.body.length}${m.daysToReply !== null ? `, replied in ${m.daysToReply}d` : ''}) ${m.body.replace(/\s+/g, ' ').trim()}`;

    const winsBlock = wins.map(formatMsg).join('\n\n');
    const dudsBlock = duds.map(formatMsg).join('\n\n');

    const systemPrompt = [
      `You are analyzing LinkedIn outbound messages sent by ${authorName}${authorRole && authorCompany ? `, a ${authorRole} at ${authorCompany}` : ''}.`,
      '',
      'Goal: extract concrete, actionable patterns that distinguish WINS (messages that produced positive replies, booked meetings) from DUDS (no reply after 14 days, or rejected). Output a Winning Patterns playbook.',
      '',
      'CRITICAL PRIVACY RULES:',
      '• NEVER quote actual message text verbatim. Describe patterns abstractly.',
      '• NEVER name specific contacts, companies, or identifying details.',
      '• Patterns must be general — "opens with a specific reference to the recipient\'s role" not "opens with mentions of Riot Games."',
      '• This playbook will be shared with teammates — anything specific to one prospect or thread does not belong here.',
      '',
      'Output a markdown document with these sections (use these exact headers):',
      '',
      '## Sample',
      '(Bullet stats: total messages, wins, duds, reply rate, sample window)',
      '',
      '## What\'s working in your wins',
      '(5-8 patterns. Each pattern includes a frequency note like "appears in X% of wins, Y% of duds". Cover: opening style, length, question count, CTA strength, tone, personalization moves, structural choices.)',
      '',
      '## What\'s underperforming',
      '(5-8 patterns specific to duds. Same frequency note format.)',
      '',
      '## Length and structure',
      '(Specific character/length ranges, sentence count, paragraph count. Be quantitative.)',
      '',
      '## Sweet-spot template',
      '(A SHAPE — not a fill-in template. Describe the ideal anatomy: e.g., "1 reference to their world + 1 specific value angle + 1 soft ask, in ~220 chars". No filled-in text.)',
      '',
      '## Avoid',
      '(3-5 specific anti-patterns. Phrases to avoid? Use abstracted descriptions of the move, not the literal phrase.)',
      '',
      'Be concrete and quantitative. Vague advice is useless. Numbers and frequencies are what makes this actionable.',
    ].join('\n');

    const userPrompt = [
      `WINS (${wins.length} messages):`,
      '---',
      winsBlock,
      '---',
      '',
      `DUDS (${duds.length} messages):`,
      '---',
      dudsBlock,
      '---',
      '',
      'Generate the Winning Patterns playbook now. Markdown only, no preamble.',
    ].join('\n');

    const anthropic = await requireAnthropic();
    const response = await anthropic.messages.create({
      model: MODELS.draft, // Sonnet — better pattern abstraction
      max_tokens: 8000,
      system: [{ type: 'text', text: systemPrompt }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const body = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
      .trim();

    // Wrap with YAML frontmatter — makes the artifact self-describing when
    // exported and shared between teammates.
    const generatedAt = new Date();
    const totalSample = wins.length + duds.length;
    const replyRate = totalSample > 0 ? (wins.length / totalSample).toFixed(3) : '0';

    const frontmatter = [
      '---',
      'kind: winning-patterns',
      `author: ${authorName}`,
      authorRole ? `authorRole: ${authorRole}` : '',
      authorCompany ? `authorCompany: ${authorCompany}` : '',
      currentEntry?.from ? `roleStartedAt: ${currentEntry.from}` : '',
      currentRoleStart ? `analysisWindowStart: ${currentRoleStart.toISOString().slice(0, 10)}` : 'analysisWindow: all-time',
      `generatedAt: ${generatedAt.toISOString()}`,
      `sampleSize: ${totalSample}`,
      `wins: ${wins.length}`,
      `duds: ${duds.length}`,
      `winRate: ${replyRate}`,
      '---',
      '',
    ].filter(Boolean).join('\n');

    const rawText = `${frontmatter}\n${body}`;
    const roleTag = authorCompany ? ` at ${authorCompany}` : '';
    const title = `${authorName} — Winning Patterns${roleTag} (${generatedAt.toISOString().slice(0, 10)})`;

    // Create the Document. summary = same as body (it IS the brief).
    const doc = await prisma.document.create({
      data: {
        title,
        kind: 'winning-patterns',
        rawText,
        summary: body,
        includeByDefault: true,
        sourceFilename: null,
        sourceMime: 'text/markdown',
      },
      select: {
        id: true, title: true, kind: true, summary: true,
        includeByDefault: true, sourceFilename: true, sourceMime: true,
        createdAt: true, updatedAt: true,
      },
    });

    // Stale-out prior self-generated playbooks so the new run isn't competing
    // with old patterns in the prompt context. We don't touch teammate
    // imports (sourceFilename != null) — those are externally owned.
    const deactivated = await prisma.document.updateMany({
      where: {
        kind: 'winning-patterns',
        sourceFilename: null,
        id: { not: doc.id },
        includeByDefault: true,
      },
      data: { includeByDefault: false },
    });

    return NextResponse.json({
      document: doc,
      stats: {
        wins: wins.length,
        duds: duds.length,
        total: totalSample,
        windowStart: currentRoleStart?.toISOString() ?? null,
        windowEntry: currentEntry ? { role: currentEntry.role, company: currentEntry.company, from: currentEntry.from } : null,
        deactivatedPriorPlaybooks: deactivated.count,
      },
      usage: response.usage,
    }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    const status = msg.startsWith('NO_API_KEY') ? 401 : 500;
    return NextResponse.json({ error: msg }, { status, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
