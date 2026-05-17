// Regex-based label detection. Cheap pass that runs on every inbound message
// to auto-tag obvious things — "not interested", out-of-office replies,
// unsubscribe requests, positive interest, meeting confirmations.
//
// Patterns are intentionally conservative — false negatives are fine,
// false positives erode trust. A more expensive Claude classification could
// catch the rest, but most of these signals are formulaic enough that regex
// catches the bulk of them at zero cost.

import { prisma } from './db';

export interface AutoLabel {
  id: string;
  name: string;
  color: string;
  pattern: RegExp;
}

export const AUTO_LABELS: AutoLabel[] = [
  {
    id: 'not-interested',
    name: 'Not Interested',
    color: '#6b7280',
    pattern: /\b(not\s+interested|no\s+thank(s|\s+you)|i'?ll?\s+pass|not\s+a\s+fit|not\s+at\s+this\s+time|not\s+(right\s+)?now|please\s+remove|take\s+me\s+off)\b/i,
  },
  {
    id: 'auto-ooo',
    name: 'Out of Office',
    color: '#a78bfa',
    pattern: /\b(out\s+of\s+(the\s+)?office|on\s+vacation|on\s+(parental\s+|paternity\s+|maternity\s+)?leave|away\s+from\s+(the\s+)?office|will\s+be\s+(out|away)|currently\s+(out|traveling)|limited\s+access\s+to\s+email)\b/i,
  },
  {
    id: 'auto-unsubscribe',
    name: 'Remove Me',
    color: '#dc2626',
    pattern: /\b(unsubscribe|stop\s+contacting|do\s+not\s+contact|do\s+not\s+message|please\s+stop|cease\s+(and\s+desist|contact))\b/i,
  },
  {
    id: 'auto-interested',
    name: 'Interested',
    color: '#22c55e',
    pattern: /\b(i'?d\s+love\s+to|sounds\s+(great|good|interesting)|tell\s+me\s+more|let'?s\s+(chat|talk|connect|schedule)|happy\s+to\s+(chat|connect|talk)|would\s+love\s+to\s+learn|count\s+me\s+in|interested\s+in\s+(learning|hearing))\b/i,
  },
  {
    id: 'auto-meeting-set',
    name: 'Meeting Set',
    color: '#0ea5e9',
    pattern: /\b(calendar\s+invite|see\s+you\s+(on|at)|on\s+(the\s+)?calendar|booked\s+(for|the)|scheduled\s+(for|at|on)|invite\s+(sent|coming)|sent\s+(you\s+)?an?\s+invite)\b/i,
  },
];

const AUTO_LABEL_IDS = new Set(AUTO_LABELS.map((l) => l.id));

// Scan a message body, return label IDs that match. Multiple labels can apply.
export function detectAutoLabels(body: string): string[] {
  if (!body) return [];
  const matches: string[] = [];
  for (const l of AUTO_LABELS) {
    if (l.pattern.test(body)) matches.push(l.id);
  }
  return matches;
}

// Ensure all auto-label rows exist in the Label table. Idempotent — safe to
// call repeatedly. Call once before applying auto-labels.
export async function ensureAutoLabelsSeeded(): Promise<void> {
  for (const l of AUTO_LABELS) {
    await prisma.label.upsert({
      where: { id: l.id },
      update: {}, // never overwrite user-customized name/color
      create: { id: l.id, name: l.name, color: l.color },
    });
  }
}

// Apply detected labels to a conversation by merging into its existing labels
// array. Returns the set of newly-added label IDs (already-present ones are
// not double-counted).
export async function applyAutoLabelsToConversation(
  conversationId: string,
  newLabelIds: string[],
): Promise<string[]> {
  if (newLabelIds.length === 0) return [];
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { labels: true },
  });
  if (!conv) return [];

  let current: string[] = [];
  try { current = JSON.parse(conv.labels); } catch {}
  const currentSet = new Set(current);
  const added: string[] = [];
  for (const id of newLabelIds) {
    if (!currentSet.has(id)) {
      currentSet.add(id);
      added.push(id);
    }
  }
  if (added.length > 0) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { labels: JSON.stringify([...currentSet]) },
    });
  }
  return added;
}

// Returns true if the given label id was auto-assigned (the user can manually
// override by removing it; we never re-add a label that was explicitly removed).
export function isAutoLabel(id: string): boolean {
  return AUTO_LABEL_IDS.has(id);
}
