// Find-or-create a Contact, merging fields with source-priority precedence.
// Used by every entry point that learns about a person: profile-capture
// (DOM scrape), profile-capture/bulk (harvester + extension), CSV import,
// and the inbox sync pipeline.
//
// Identity resolution priority:
//   linkedinUrn > profileSlug > normalized(name)
// "LinkedIn User" / "LinkedIn Member" are placeholder names; they're NEVER
// used for name-based matching. Sentinel-named contacts with no URN and no
// slug get a fresh row each time (different people share the placeholder).

import { prisma } from './db';
import { createNotification } from './notify';

export type ContactSource = 'linkedin-export' | 'dom-capture' | 'ai-headline' | 'harvest';

const SOURCE_PRIORITY: Record<string, number> = {
  'linkedin-export': 4,
  'dom-capture': 3,
  'ai-headline': 2,
  'harvest': 1,
};

const SENTINEL_NAMES = new Set(['linkedin user', 'linkedin member']);

export interface ContactInput {
  linkedinUrn?: string | null;
  profileSlug?: string | null;
  profileUrl?: string | null;
  name: string;
  headline?: string | null;
  avatarUrl?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  role?: string | null;
  location?: string | null;
  industry?: string | null;
  tenure?: string | null;
  connectedOn?: Date | null;
  source: ContactSource;
  // Expanded enrichment (Phase 2). Stored verbatim — server doesn't validate
  // the shape of prevRoles / education / recentPosts JSON.
  about?: string | null;
  prevRoles?: unknown;
  education?: unknown;
  recentPosts?: unknown;
}

// Parses LinkedIn's "DD MMM YYYY" date format (e.g. "12 May 2026") into a Date.
// Returns null on parse failure — never throws.
export function parseLinkedInDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  // Match "12 May 2026" or "1 Mar 2024"
  const m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) {
    // Fall back to native Date parsing for unexpected formats.
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, day, mon, year] = m;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mi = months[mon.toLowerCase().slice(0, 3)];
  if (mi === undefined) return null;
  const d = new Date(Date.UTC(Number(year), mi, Number(day)));
  return isNaN(d.getTime()) ? null : d;
}

export function extractProfileUrn(raw?: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

export function extractProfileSlug(profileUrl?: string | null): string | null {
  if (!profileUrl) return null;
  try {
    const u = new URL(profileUrl);
    if (!u.pathname.startsWith('/in/')) return null;
    const slug = u.pathname.replace(/^\/in\/|\/+$/g, '').split('/')[0];
    return slug || null;
  } catch {
    return null;
  }
}

function normalizeName(s?: string | null): string {
  if (!s) return '';
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isSentinelName(s?: string | null): boolean {
  return SENTINEL_NAMES.has(normalizeName(s));
}

// Returns the contact id, or null if input lacks a usable name.
export async function upsertContact(input: ContactInput): Promise<string | null> {
  const name = (input.name || '').trim();
  if (!name) return null;

  const isAnon = !input.linkedinUrn && !input.profileSlug && isSentinelName(name);
  const now = new Date();

  // Anonymous: always create a fresh row — same placeholder name across
  // different real people must not collapse.
  if (isAnon) {
    const created = await prisma.contact.create({
      data: {
        name,
        profileUrl: input.profileUrl ?? null,
        headline: input.headline ?? null,
        avatarUrl: input.avatarUrl ?? null,
        company: input.company ?? null,
        companyDomain: input.companyDomain ?? null,
        role: input.role ?? null,
        location: input.location ?? null,
        industry: input.industry ?? null,
        tenure: input.tenure ?? null,
        connectedOn: input.connectedOn ?? null,
        source: input.source,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    return created.id;
  }

  // Try to find an existing contact: URN > slug > exact name (only when
  // the name is unambiguous).
  let existing = null;
  if (input.linkedinUrn) {
    existing = await prisma.contact.findUnique({ where: { linkedinUrn: input.linkedinUrn } });
  }
  if (!existing && input.profileSlug) {
    existing = await prisma.contact.findUnique({ where: { profileSlug: input.profileSlug } });
  }
  if (!existing && !isSentinelName(name)) {
    // Name match — prefer candidates without a committed identity, so we
    // don't accidentally merge into a stronger record.
    const candidates = await prisma.contact.findMany({
      where: { name },
      select: { id: true, linkedinUrn: true, profileSlug: true, source: true },
      take: 20,
    });
    existing = candidates.sort((a, b) => {
      const aIdentity = (a.linkedinUrn ? 1 : 0) + (a.profileSlug ? 1 : 0);
      const bIdentity = (b.linkedinUrn ? 1 : 0) + (b.profileSlug ? 1 : 0);
      return aIdentity - bIdentity;
    })[0] ?? null;
  }

  if (!existing) {
    const created = await prisma.contact.create({
      data: {
        name,
        linkedinUrn: input.linkedinUrn ?? null,
        profileSlug: input.profileSlug ?? null,
        profileUrl: input.profileUrl ?? null,
        headline: input.headline ?? null,
        avatarUrl: input.avatarUrl ?? null,
        company: input.company ?? null,
        companyDomain: input.companyDomain ?? null,
        role: input.role ?? null,
        location: input.location ?? null,
        industry: input.industry ?? null,
        tenure: input.tenure ?? null,
        connectedOn: input.connectedOn ?? null,
        about: input.about ?? null,
        prevRoles: input.prevRoles ? JSON.stringify(input.prevRoles) : null,
        education: input.education ? JSON.stringify(input.education) : null,
        recentPosts: input.recentPosts ? JSON.stringify(input.recentPosts) : null,
        recentPostsAt: input.recentPosts ? now : null,
        source: input.source,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    // Seed the initial snapshot so future diffs have a baseline
    if (input.company || input.role || input.headline) {
      await prisma.contactSnapshot.create({
        data: {
          contactId: created.id,
          company: input.company ?? null,
          companyDomain: input.companyDomain ?? null,
          role: input.role ?? null,
          headline: input.headline ?? null,
          source: input.source,
          capturedAt: now,
        },
      });
    }
    return created.id;
  }

  // Merge — identity keys fill-if-missing, position fields obey source priority.
  const existingFull = await prisma.contact.findUnique({ where: { id: existing.id } });
  if (!existingFull) return existing.id;

  const existingPriority = SOURCE_PRIORITY[existingFull.source ?? ''] ?? 0;
  const incomingPriority = SOURCE_PRIORITY[input.source] ?? 0;
  const canOverwrite = incomingPriority >= existingPriority;

  const patch: Record<string, unknown> = { lastSeenAt: now };

  // Identity: only fill missing (never overwrite — collisions need manual merge)
  if (!existingFull.linkedinUrn && input.linkedinUrn) patch.linkedinUrn = input.linkedinUrn;
  if (!existingFull.profileSlug && input.profileSlug) patch.profileSlug = input.profileSlug;
  if (!existingFull.profileUrl && input.profileUrl) patch.profileUrl = input.profileUrl;
  if (!existingFull.avatarUrl && input.avatarUrl) patch.avatarUrl = input.avatarUrl;
  // connectedOn: prefer the EARLIER date (when in doubt, earlier connection wins)
  if (input.connectedOn) {
    if (!existingFull.connectedOn || input.connectedOn < existingFull.connectedOn) {
      patch.connectedOn = input.connectedOn;
    }
  }

  // Position fields: incoming wins if source rank >= existing, else only fill missing
  const fieldPairs: Array<[keyof ContactInput, keyof typeof existingFull]> = [
    ['headline', 'headline'],
    ['company', 'company'],
    ['companyDomain', 'companyDomain'],
    ['role', 'role'],
    ['location', 'location'],
    ['industry', 'industry'],
    ['tenure', 'tenure'],
  ];
  for (const [inKey, exKey] of fieldPairs) {
    const v = input[inKey];
    if (!v) continue;
    if (canOverwrite || !existingFull[exKey]) patch[exKey as string] = v;
  }

  // Name: only update if source rank > existing (don't downgrade real name to sentinel)
  if (input.name && canOverwrite && !isSentinelName(input.name) && input.name !== existingFull.name) {
    patch.name = input.name;
  }

  // Expanded enrichment — string for about, JSON-stringified for arrays
  if (input.about && (canOverwrite || !existingFull.about)) patch.about = input.about;
  if (input.prevRoles && (canOverwrite || !existingFull.prevRoles)) {
    patch.prevRoles = JSON.stringify(input.prevRoles);
  }
  if (input.education && (canOverwrite || !existingFull.education)) {
    patch.education = JSON.stringify(input.education);
  }
  // Recent posts are temporal — always refresh on a more recent fetch
  if (input.recentPosts) {
    patch.recentPosts = JSON.stringify(input.recentPosts);
    patch.recentPostsAt = now;
  }

  // Bump source only upward
  if (incomingPriority > existingPriority) patch.source = input.source;

  // Detect a job-change-worthy diff: company, role, or headline changed to
  // a different non-empty value. Snapshot the NEW state after update so the
  // Tasks "Job Changes" view can diff against the prior snapshot.
  const fieldsChanged = (
    (typeof patch.company === 'string' && patch.company !== existingFull.company) ||
    (typeof patch.role === 'string' && patch.role !== existingFull.role) ||
    (typeof patch.headline === 'string' && patch.headline !== existingFull.headline) ||
    (typeof patch.companyDomain === 'string' && patch.companyDomain !== existingFull.companyDomain)
  );

  if (Object.keys(patch).length > 1) {
    await prisma.contact.update({ where: { id: existingFull.id }, data: patch });
  }

  if (fieldsChanged) {
    await prisma.contactSnapshot.create({
      data: {
        contactId: existingFull.id,
        company: (patch.company as string | undefined) ?? existingFull.company,
        companyDomain: (patch.companyDomain as string | undefined) ?? existingFull.companyDomain,
        role: (patch.role as string | undefined) ?? existingFull.role,
        headline: (patch.headline as string | undefined) ?? existingFull.headline,
        source: input.source,
        capturedAt: now,
      },
    });

    // Bell notification — only when this is a genuine job change (company
    // changed) vs a minor headline/role edit. Skips if there's no prior
    // company OR the only diff is the role at the same company.
    const newCompany = (patch.company as string | undefined) ?? existingFull.company;
    const companyChanged = !!(existingFull.company && newCompany && newCompany !== existingFull.company);
    if (companyChanged) {
      await createNotification({
        kind: 'job-change',
        title: `${existingFull.name} changed jobs`,
        body: `${existingFull.company} → ${newCompany}${patch.role ? ` (${patch.role as string})` : ''}`,
        contactId: existingFull.id,
        meta: { previousCompany: existingFull.company, newCompany, previousRole: existingFull.role, newRole: patch.role ?? null },
      });
    }
  }

  return existingFull.id;
}

// Walks a conversation's participants (in the Participant JSON shape),
// upserts each as a Contact, and links them to the conversation. Pass
// selfUrn to skip the user's own participant in group threads.
// Source defaults to 'harvest' — sync data carries enrichment via the
// Conversation.enrichment field which higher-priority paths will overwrite.
export async function linkParticipantsToConversation(
  conversationId: string,
  participants: Array<{
    id?: string | null;
    name?: string | null;
    headline?: string | null;
    profileUrl?: string | null;
    avatarUrl?: string | null;
    company?: string | null;
  }>,
  selfUrn: string | null = null,
  source: ContactSource = 'harvest',
): Promise<number> {
  let linked = 0;
  for (const p of participants) {
    const urn = extractProfileUrn(p.id);
    if (selfUrn && urn === selfUrn) continue;
    if (!p.name) continue;
    const slug = extractProfileSlug(p.profileUrl);
    const cid = await upsertContact({
      linkedinUrn: urn,
      profileSlug: slug,
      profileUrl: p.profileUrl ?? null,
      name: p.name,
      headline: p.headline ?? null,
      avatarUrl: p.avatarUrl ?? null,
      company: p.company ?? null,
      source,
    });
    if (cid) {
      await linkContactToConversation(cid, conversationId);
      linked++;
    }
  }
  return linked;
}

// Idempotent link between a Contact and a Conversation. Safe to call twice.
export async function linkContactToConversation(contactId: string, conversationId: string): Promise<void> {
  try {
    await prisma.conversationContact.create({
      data: { contactId, conversationId },
    });
    // Bump the contact's conversationCount rollup
    await prisma.contact.update({
      where: { id: contactId },
      data: { conversationCount: { increment: 1 } },
    });
  } catch (e) {
    // Compound primary key violation = already linked. Safe to ignore.
    if (e instanceof Error && /Unique constraint|UNIQUE constraint/i.test(e.message)) return;
    throw e;
  }
}
