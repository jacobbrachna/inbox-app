export type InboxSource = 'linkedin' | 'sales_nav' | 'all';

export type Label = {
  id: string;
  name: string;
  color: string;
  // description: AI uses this when deciding whether to apply the label.
  // Null = user-only label (won't be auto-applied).
  description?: string | null;
  aiManaged?: boolean;
  // exclusiveGroup: labels sharing a group key are mutually exclusive on a
  // conversation. Null = no group constraint.
  exclusiveGroup?: string | null;
  count?: number;
};

export type ConversationStatus = 'unread' | 'read' | 'snoozed' | 'archived' | 'draft';

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

export type RoleEntry = {
  role: string | null;
  company: string | null;
  from: string | null;
  to: string | null;
};
export type EducationEntry = {
  school: string | null;
  degree: string | null;
  from: string | null;
  to: string | null;
};
export type RecentPost = {
  url: string | null;
  text: string | null;
  postedAt: string | null;
  kind: 'post' | 'reshare';
};

export type Enrichment = {
  company?: string;
  role?: string;
  location?: string;
  industry?: string;
  tenure?: string;
  headline?: string;
  about?: string;
  prevRoles?: RoleEntry[];
  education?: EducationEntry[];
  skills?: string[];
  recentPosts?: RecentPost[];
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
  followUpReason?: string | null;
  followUpSource?: 'manual' | 'ai' | null;
  followUpConfidence?: 'high' | 'low' | null;
  followUpKind?: 'commitment' | 'soft' | null;
  followUpActor?: 'self' | 'them' | 'either' | null;
  needsReview?: boolean;
  notes?: string;
  isStarred?: boolean;
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
  | 'tasks'
  | 'contacts'
  | 'review'
  | 'has-notes'
  | 'drafts'
  | `label:${string}`
  | `company:${string}`
  | `role:${string}`
  | `recency:${'7d' | '30d' | 'older'}`;
