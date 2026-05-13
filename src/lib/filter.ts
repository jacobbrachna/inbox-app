import type { Conversation, FilterView } from '@/types';

/**
 * Apply the active filter view + search query to a list of conversations.
 * Shared between the conversation list component (which renders the list)
 * and the store (which needs to know what "select all" means).
 */
export function filterConversations(
  conversations: Conversation[],
  activeFilter: FilterView,
  searchQuery: string,
): Conversation[] {
  let result = conversations;

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
