// Canonical set of AI-managed labels seeded into the Label table. Each row
// carries a `description` the AI reads to decide when to apply it, plus an
// optional `exclusiveGroup` so contradictory labels can't co-exist on a
// conversation.
//
// Users can ADD their own labels via the UI; those join this set with
// `aiManaged: true` and their user-provided description.

import { prisma } from './db';

export interface AILabelSeed {
  id: string;
  name: string;
  color: string;
  description: string;
  exclusiveGroup: string | null;
}

// Mutex groups:
//   origin         — how this thread started (recruiter / sales pitch / intro)
//   interest-state — where the prospect's interest sits
//   meeting-state  — meeting lifecycle (booked vs done)
// Other labels (OOO, Their question pending) have no group → they can
// co-exist with anything in the above groups.
export const AI_LABEL_SEEDS: AILabelSeed[] = [
  {
    id: 'ai-recruiter',
    name: 'Recruiter',
    color: '#a78bfa',
    description: 'A recruiter, sourcer, or in-house talent acquisition person reached out about a job opportunity FOR the user. Strong signals: words like "role", "position", "opportunity", "team", "hiring", "opening", "we\'re looking for", "would you be interested in", "[job title] role at [company]", "saw your background", "your experience with X". Also: messages mentioning compensation, comp ranges, salary bands, OR scheduling a "quick chat about a role". The sender works FOR a company hiring, or for a recruiting firm. Apply this label even if the user has not yet replied. Do NOT apply when the sender is pitching their own product or service to the user — that is Sales pitch.',
    exclusiveGroup: 'origin',
  },
  {
    id: 'ai-sales-pitch',
    name: 'Sales pitch',
    color: '#f97316',
    description: 'Someone is pitching the user their own product, service, agency, or solution — trying to SELL to the user. Strong signals: "I help [companies] do X", "we offer", "our platform", "our agency", "case study", "would love to show you", "schedule a demo", "free trial", "introduce you to our [product/service]", "increase your [metric]". The sender or their company is the vendor; the user would be the customer. Often mass outreach with templated intros. Do NOT apply for recruiters offering jobs (that is Recruiter).',
    exclusiveGroup: 'origin',
  },
  {
    id: 'ai-mutual-intro',
    name: 'Mutual intro',
    color: '#0ea5e9',
    description: 'A networking introduction, mutual referral, or warm intro from a shared connection. Neither party is selling — it is relationship building.',
    exclusiveGroup: 'origin',
  },
  {
    id: 'ai-spam',
    name: 'Spam',
    color: '#dc2626',
    description: 'Obvious junk or low-effort mass outreach. Templated cold messages with no personalization, scams, MLM pitches, crypto/AI hype with no relevance, automated bots, or messages that show zero understanding of who the user is. Apply when the message reads like it was blasted to thousands of people. Spam goes in the origin group — it replaces what would otherwise be Recruiter / Sales pitch / Mutual intro when the outreach has no legitimate intent.',
    exclusiveGroup: 'origin',
  },
  {
    id: 'ai-interested',
    name: 'Showed interest',
    color: '#22c55e',
    description: 'The prospect has engaged positively, asked questions, expressed curiosity, or otherwise signaled they want to know more — but no firm meeting has been scheduled yet.',
    exclusiveGroup: 'interest-state',
  },
  {
    id: 'not-interested',
    name: 'Not Interested',
    color: '#6b7280',
    description: 'The prospect explicitly or strongly implied they do not want to engage — said no, asked to be removed, said "not a fit", "not at this time", or similar disengagement.',
    exclusiveGroup: 'interest-state',
  },
  {
    id: 'ai-ghosted',
    name: 'Ghosted',
    color: '#94a3b8',
    description: 'The user sent the most recent message(s) and the prospect has gone silent for 30+ days. This is an activity state, NOT an attitude — it can co-exist with "Showed interest" (warm but went quiet) or "Not interested" (declined and then disappeared). Apply whenever the silence is significant, regardless of the prior interest state.',
    exclusiveGroup: null,
  },
  {
    id: 'ai-meeting-booked',
    name: 'Meeting booked',
    color: '#3b82f6',
    description: 'A meeting or call is scheduled. Calendar invite was sent or both parties confirmed a specific time. Has not happened yet.',
    exclusiveGroup: 'meeting-state',
  },
  {
    id: 'ai-meeting-done',
    name: 'Meeting done',
    color: '#7c3aed',
    description: 'A meeting or call has already taken place; the conversation now references it in past tense. Often awaiting follow-up or next-step decisions.',
    exclusiveGroup: 'meeting-state',
  },
  {
    id: 'ai-question-pending',
    name: 'Their question pending',
    color: '#eab308',
    description: 'The prospect asked a question or requested something specific in their most recent message, and the user has not yet replied. Action is on the user.',
    exclusiveGroup: null,
  },
  {
    id: 'auto-ooo',
    name: 'Out of Office',
    color: '#fb7185',
    description: 'The most recent inbound message is an automated out-of-office reply. The actual person is unavailable; do not treat the OOO content as their real response.',
    exclusiveGroup: null,
  },
];

// Idempotent: upserts every seed row. Never overwrites a user-customized
// name/color — only fills missing description + aiManaged + exclusiveGroup
// on existing rows.
export async function seedAILabels(): Promise<void> {
  for (const s of AI_LABEL_SEEDS) {
    const existing = await prisma.label.findUnique({ where: { id: s.id } });
    if (!existing) {
      await prisma.label.create({
        data: {
          id: s.id,
          name: s.name,
          color: s.color,
          description: s.description,
          aiManaged: true,
          exclusiveGroup: s.exclusiveGroup,
        },
      });
    } else {
      // Preserve user-customized name/color. Fill missing AI fields.
      await prisma.label.update({
        where: { id: s.id },
        data: {
          description: existing.description ?? s.description,
          aiManaged: true,
          exclusiveGroup: existing.exclusiveGroup ?? s.exclusiveGroup,
        },
      });
    }
  }
}

// Returns all AI-managed labels (seeded + user-created with aiManaged=true).
export async function loadAIManagedLabels() {
  return prisma.label.findMany({
    where: { aiManaged: true, description: { not: null } },
    orderBy: { name: 'asc' },
  });
}

// Enforces exclusiveGroup: when multiple labels in the same group are
// proposed, keep the FIRST one (caller should order by precedence).
// Labels with no group always pass through.
export function applyExclusiveGroups<T extends { id: string; exclusiveGroup: string | null }>(
  proposed: T[],
): T[] {
  const seenGroups = new Set<string>();
  const out: T[] = [];
  for (const l of proposed) {
    if (!l.exclusiveGroup) { out.push(l); continue; }
    if (seenGroups.has(l.exclusiveGroup)) continue;
    seenGroups.add(l.exclusiveGroup);
    out.push(l);
  }
  return out;
}
