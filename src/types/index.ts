export type InboxSource = 'linkedin' | 'sales_nav' | 'all';

export type Label = {
  id: string;
  name: string;
  color: string;
  count?: number;
};

export type ConversationStatus = 'unread' | 'read' | 'snoozed' | 'archived';

export type Participant = {
  id: string;
  name: string;
  headline?: string;
  profileUrl?: string;
  avatarUrl?: string;
  company?: string;
};

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  sentAt: string;
  deliveredAt?: string;
  readAt?: string;
  isFromMe: boolean;
};

export type AiCategory =
  | 'cold-pitch'
  | 'warm-lead'
  | 'client'
  | 'recruiter'
  | 'intro'
  | 'spam'
  | 'other';

export type Enrichment = {
  company?: string;
  role?: string;
  location?: string;
  industry?: string;
  tenure?: string;
  // Raw payload we keep around for surfacing extra fields later
  raw?: Record<string, unknown>;
};

export type Conversation = {
  id: string;
  source: InboxSource;
  participants: Participant[];
  lastMessage: string;
  lastMessageAt: string;
  lastMessageSenderId: string;
  unreadCount: number;
  status: ConversationStatus;
  labels: string[];
  snoozedUntil?: string | null;
  followUpAt?: string | null;
  notes?: string;
  isStarred?: boolean;
  aiCategory?: AiCategory | null;
  aiSummary?: string | null;
  enrichment?: Enrichment | null;
};

export type Snippet = {
  id: string;
  name: string;
  shortcut: string;
  body: string;
};

export type AuthState = {
  liAtCookie: string;
  jsessionId?: string;
  fullCookieString?: string;  // full browser cookie header — most reliable
  isAuthenticated: boolean;
  profileId?: string;
  profileName?: string;
  profileAvatarUrl?: string;
};

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success';

export type FilterView =
  | 'all'
  | 'unread'
  | 'starred'
  | 'snoozed'
  | 'follow-up'
  | 'archived'
  | 'linkedin'
  | 'sales_nav'
  | 'settings'
  | 'analytics'
  | 'diagnostics'
  | 'queue'
  | 'has-notes'
  | `label:${string}`
  | `company:${string}`
  | `role:${string}`
  | `recency:${'7d' | '30d' | 'older'}`;
