import type { Conversation, FilterView } from '@/types';

/**
 * Apply the active filter view + search query to a list of conversations.
 * Shared between the conversation list component (which renders the list)
 * and the store (which needs to know what "select all" means).
 *
 * Optional `currentRoleStart` is a global view toggle — when set, every
 * non-drafts filter additionally hides conversations whose entire activity
 * predates the user's current role. Lets the user trim baggage from
 * previous-employer-era threads without losing them entirely.
 */
export function filterConversations(
  conversations: Conversation[],
  activeFilter: FilterView,
  searchQuery: string,
  currentRoleStart?: Date | null,
): Conversation[] {
  // Drafts are completely isolated from every other view — they only appear
  // under the dedicated 'drafts' filter. Strip them up-front so we never have
  // to re-check inside every branch below.
  const nonDrafts = conversations.filter((c) => c.status !== 'draft');
  let result = activeFilter === 'drafts'
    ? conversations.filter((c) => c.status === 'draft')
    : nonDrafts;

  // Current-role toggle — pre-filter to threads with activity since the
  // user's role start. Skip for drafts (they're new outbound, not historic).
  if (currentRoleStart && activeFilter !== 'drafts') {
    const cutoffMs = currentRoleStart.getTime();
    result = result.filter((c) => new Date(c.lastMessageAt).getTime() >= cutoffMs);
  }

  if (activeFilter === 'drafts') {
    // Already filtered above; apply search if any, then return early so we
    // don't fall through any of the other branches (most would no-op anyway
    // but explicit is safer as we add filters later).
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) =>
          c.participants.some((p) => p.name.toLowerCase().includes(q)) ||
          c.lastMessage.toLowerCase().includes(q),
      );
    }
    // Drafts sort by lastMessageAt desc (= when they were last edited).
    return result.slice().sort((a, b) =>
      new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    );
  }

  if (activeFilter === 'unread') result = result.filter((c) => c.status === 'unread');
  else if (activeFilter === 'starred') result = result.filter((c) => c.isStarred);
  else if (activeFilter === 'snoozed') result = result.filter((c) => c.status === 'snoozed');
  else if (activeFilter === 'follow-up') {
    const now = Date.now();
    result = result
      .filter((c) => !!c.followUpAt)
      .slice()
      .sort((a, b) => {
        const aT = new Date(a.followUpAt!).getTime();
        const bT = new Date(b.followUpAt!).getTime();
        const aOverdue = aT < now;
        const bOverdue = bT < now;
        // Overdue first
        if (aOverdue && !bOverdue) return -1;
        if (!aOverdue && bOverdue) return 1;
        // Within overdue: oldest first (most overdue). Within upcoming: soonest first.
        return aT - bT;
      });
  }
  else if (activeFilter === 'archived') result = result.filter((c) => c.status === 'archived');
  else if (activeFilter === 'linkedin') result = result.filter((c) => c.source === 'linkedin');
  else if (activeFilter === 'sales_nav') result = result.filter((c) => c.source === 'sales_nav');
  else if (activeFilter?.startsWith('label:')) {
    const labelId = activeFilter.replace('label:', '');
    result = result.filter((c) => c.labels.includes(labelId));
  }
  else if (activeFilter?.startsWith('company:')) {
    const target = activeFilter.replace('company:', '').toLowerCase();
    result = result.filter((c) => {
      const company = (c.enrichment as { company?: string } | null | undefined)?.company;
      return typeof company === 'string' && company.toLowerCase() === target;
    });
  }
  else if (activeFilter?.startsWith('role:')) {
    const target = activeFilter.replace('role:', '').toLowerCase();
    result = result.filter((c) => {
      const role = (c.enrichment as { role?: string } | null | undefined)?.role;
      return typeof role === 'string' && role.toLowerCase().includes(target);
    });
  }
  else if (activeFilter?.startsWith('recency:')) {
    const key = activeFilter.replace('recency:', '');
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    result = result.filter((c) => {
      const age = now - new Date(c.lastMessageAt).getTime();
      if (key === '7d') return age <= 7 * dayMs;
      if (key === '30d') return age <= 30 * dayMs;
      if (key === 'older') return age > 30 * dayMs;
      return true;
    });
  }
  else if (activeFilter === 'has-notes') {
    result = result.filter((c) => !!c.notes && c.notes.trim().length > 0);
  }
  else if (activeFilter === 'review') {
    result = result.filter((c) => c.needsReview === true);
  } else {
    // 'all' — exclude archived
    result = result.filter((c) => c.status !== 'archived');
  }

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    result = result.filter(
      (c) =>
        c.participants.some((p) => p.name.toLowerCase().includes(q)) ||
        c.lastMessage.toLowerCase().includes(q),
    );
  }

  return result;
}
