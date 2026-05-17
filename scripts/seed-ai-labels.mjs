// One-shot: seed the AI-managed label set. Idempotent — safe to re-run.
//
// Usage: node scripts/seed-ai-labels.mjs

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });

const AI_LABEL_SEEDS = [
  { id: 'ai-recruiter', name: 'Recruiter', color: '#a78bfa',
    description: 'A recruiter or talent partner reached out about a job opportunity, hiring pitch, or sourcing for a role. The sender is trying to recruit the user, not sell them something.',
    exclusiveGroup: 'origin' },
  { id: 'ai-sales-pitch', name: 'Sales pitch', color: '#f97316',
    description: 'Someone is pitching the user their product, service, or agency. Often mass outreach. The sender is selling to the user.',
    exclusiveGroup: 'origin' },
  { id: 'ai-mutual-intro', name: 'Mutual intro', color: '#0ea5e9',
    description: 'A networking introduction, mutual referral, or warm intro from a shared connection. Neither party is selling — it is relationship building.',
    exclusiveGroup: 'origin' },
  { id: 'ai-spam', name: 'Spam', color: '#dc2626',
    description: 'Obvious junk or low-effort mass outreach. Templated cold messages with no personalization, scams, MLM pitches, crypto/AI hype with no relevance, automated bots, or messages that show zero understanding of who the user is. Apply when the message reads like it was blasted to thousands of people. Spam goes in the origin group — it replaces what would otherwise be Recruiter / Sales pitch / Mutual intro when the outreach has no legitimate intent.',
    exclusiveGroup: 'origin' },
  { id: 'ai-interested', name: 'Showed interest', color: '#22c55e',
    description: 'The prospect has engaged positively, asked questions, expressed curiosity, or otherwise signaled they want to know more — but no firm meeting has been scheduled yet.',
    exclusiveGroup: 'interest-state' },
  { id: 'not-interested', name: 'Not Interested', color: '#6b7280',
    description: 'The prospect explicitly or strongly implied they do not want to engage — said no, asked to be removed, said "not a fit", "not at this time", or similar disengagement.',
    exclusiveGroup: 'interest-state' },
  { id: 'ai-ghosted', name: 'Ghosted', color: '#94a3b8',
    description: 'The user has sent 3+ outbound messages with no inbound reply for an extended period (30+ days). The prospect went silent without an explicit no.',
    exclusiveGroup: 'interest-state' },
  { id: 'ai-meeting-booked', name: 'Meeting booked', color: '#3b82f6',
    description: 'A meeting or call is scheduled. Calendar invite was sent or both parties confirmed a specific time. Has not happened yet.',
    exclusiveGroup: 'meeting-state' },
  { id: 'ai-meeting-done', name: 'Meeting done', color: '#7c3aed',
    description: 'A meeting or call has already taken place; the conversation now references it in past tense. Often awaiting follow-up or next-step decisions.',
    exclusiveGroup: 'meeting-state' },
  { id: 'ai-question-pending', name: 'Their question pending', color: '#eab308',
    description: 'The prospect asked a question or requested something specific in their most recent message, and the user has not yet replied. Action is on the user.',
    exclusiveGroup: null },
  { id: 'auto-ooo', name: 'Out of Office', color: '#fb7185',
    description: 'The most recent inbound message is an automated out-of-office reply. The actual person is unavailable; do not treat the OOO content as their real response.',
    exclusiveGroup: null },
];

let created = 0, updated = 0;
for (const s of AI_LABEL_SEEDS) {
  const existing = await prisma.label.findUnique({ where: { id: s.id } });
  if (!existing) {
    await prisma.label.create({
      data: { ...s, aiManaged: true },
    });
    created++;
  } else {
    await prisma.label.update({
      where: { id: s.id },
      data: {
        description: existing.description ?? s.description,
        aiManaged: true,
        exclusiveGroup: existing.exclusiveGroup ?? s.exclusiveGroup,
      },
    });
    updated++;
  }
}
console.log(`✓ Seeded AI labels — ${created} created, ${updated} updated`);
await prisma.$disconnect();
