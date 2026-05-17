import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthState, Conversation, FilterView, Label, Message, Snippet, SyncStatus } from '@/types';
import { filterConversations } from '@/lib/filter';
import { storage } from '@/lib/storage';
import { isExtensionReady } from '@/lib/use-extension-ready';

// ─── Auth store ───────────────────────────────────────────────────────────────
// Auth lives in localStorage so the user doesn't have to re-paste cookies on
// every page load. Conversations/messages/labels/snippets are NOT persisted —
// SQLite is the source of truth.

interface AuthStore {
  auth: AuthState;
  setAuth: (auth: Partial<AuthState>) => void;
  clearAuth: () => void;
  mirrorToLinkedIn: boolean;
  setMirrorToLinkedIn: (v: boolean) => void;
}

// Helper: fire a mirror request to the extension bridge. Logs the result so we
// can see when LinkedIn rejects something.
function fireMirror(kind: string, urn: string, value?: unknown) {
  try {
    if (!isExtensionReady()) {
      console.warn('[InboxPro mirror] extension bridge not found — action not mirrored to LinkedIn:', kind);
      return;
    }
    const requestId = `mirror-${Date.now()}-${Math.random()}`;
    function onResult(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type !== 'inboxpro-mirror-result' || ev.data.requestId !== requestId) return;
      window.removeEventListener('message', onResult);
      const r = ev.data.response;
      if (r?.ok) {
        console.log(`[InboxPro mirror] ${kind} → LinkedIn OK`);
      } else {
        console.error(`[InboxPro mirror] ${kind} failed:`, r);
      }
    }
    window.addEventListener('message', onResult);
    setTimeout(() => window.removeEventListener('message', onResult), 15_000);
    window.postMessage(
      { type: 'inboxpro-mirror-request', kind, urn, value, requestId },
      '*',
    );
  } catch (e) {
    console.error('[InboxPro mirror] error:', e);
  }
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      auth: { liAtCookie: '', isAuthenticated: false },
      setAuth: (auth) => set((s) => ({ auth: { ...s.auth, ...auth } })),
      clearAuth: () => set({ auth: { liAtCookie: '', isAuthenticated: false } }),
      // Default ON — actions in InboxPro should reflect back to LinkedIn by
      // default. Snooze is local-only (LinkedIn doesn't have snooze).
      mirrorToLinkedIn: true,
      setMirrorToLinkedIn: (v) => set({ mirrorToLinkedIn: v }),
    }),
    { name: 'inbox-auth' },
  ),
);

// ─── Defaults seeded into the DB on first run ─────────────────────────────────

const DEFAULT_LABELS: Label[] = [
  { id: 'hot-lead', name: 'Hot Lead', color: '#ef4444' },
  { id: 'follow-up', name: 'Follow Up', color: '#f97316' },
  { id: 'client', name: 'Client', color: '#22c55e' },
  { id: 'nurture', name: 'Nurture', color: '#3b82f6' },
  { id: 'not-interested', name: 'Not Interested', color: '#6b7280' },
];

const DEFAULT_SNIPPETS: Snippet[] = [
  {
    id: 'intro',
    name: 'Introduction',
    shortcut: '/intro',
    body: "Hi {{name}}, I came across your profile and noticed you're at {{company}}. I'd love to connect and share how we're helping teams like yours.",
  },
  {
    id: 'followup',
    name: 'Follow Up',
    shortcut: '/fu',
    body: "Hi {{name}}, just wanted to follow up on my last message. Would you be open to a quick 15-minute call this week?",
  },
  {
    id: 'meeting',
    name: 'Book Meeting',
    shortcut: '/book',
    body: "Happy to chat! Here's my calendar link to find a time that works: {{calendar_link}}",
  },
];

// ─── Main app store ───────────────────────────────────────────────────────────

interface AppState {
  // Auth (proxied through useAuthStore for components that import useStore)
  auth: AuthState;
  setAuth: (auth: Partial<AuthState>) => void;
  clearAuth: () => void;

  // Conversations
  conversations: Conversation[];
  setConversations: (convos: Conversation[]) => void;
  upsertConversation: (convo: Conversation) => void;
  updateConversation: (id: string, patch: Partial<Conversation>) => void;
  deleteConversation: (id: string) => void;

  // Active conversation
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;

  // Bulk selection (per-session UI state — NOT persisted)
  selectedIds: Set<string>;
  toggleSelected: (id: string) => void;
  setSelected: (ids: string[] | Set<string>) => void;
  clearSelection: () => void;
  selectAll: () => void;
  bulkUpdate: (patch: Partial<Conversation>) => Promise<void>;
  bulkDelete: () => Promise<void>;

  // Messages per conversation (in-memory cache only)
  messages: Record<string, Message[]>;
  setMessages: (conversationId: string, messages: Message[]) => void;
  loadMessages: (conversationId: string) => Promise<void>;

  // UI state
  activeFilter: FilterView;
  setActiveFilter: (f: FilterView) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  composeOpen: boolean;
  setComposeOpen: (v: boolean) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  // "Current role only" view toggle — hides threads whose entire activity
  // predates the user's current employment start. Loaded from
  // myEmploymentHistory via /api/patterns. Toggle state persisted in
  // localStorage; the role-start date is server-derived.
  currentRoleOnly: boolean;
  setCurrentRoleOnly: (v: boolean) => void;
  currentRoleStart: string | null; // ISO date
  currentRoleLabel: string | null; // e.g. "Bedrock Data" — for the UI badge
  setCurrentRoleMeta: (start: string | null, label: string | null) => void;

  // Labels
  labels: Label[];
  addLabel: (label: Label) => void;
  removeLabel: (id: string) => void;

  // Snippets
  snippets: Snippet[];
  addSnippet: (snippet: Snippet) => void;
  removeSnippet: (id: string) => void;

  // Sync
  syncStatus: SyncStatus;
  setSyncStatus: (s: SyncStatus) => void;
  lastSyncedAt: string | null;
  setLastSyncedAt: (t: string) => void;

  // Bootstrap from server (DB)
  loadFromServer: () => Promise<void>;
  hasLoaded: boolean;

  // Auto-refresh — polls /api/state and reloads conversations when the DB has
  // grown (i.e. the extension just pushed new data). Returns a cleanup fn.
  startAutoRefresh: () => () => void;
}

export const useStore = create<AppState>()((set, get) => ({
  // ─── Auth (delegated to useAuthStore) ──────────────────────────────────────
  auth: useAuthStore.getState().auth,
  setAuth: (auth) => {
    useAuthStore.getState().setAuth(auth);
    set({ auth: useAuthStore.getState().auth });
  },
  clearAuth: () => {
    useAuthStore.getState().clearAuth();
    set({ auth: useAuthStore.getState().auth });
  },

  // ─── Conversations ──────────────────────────────────────────────────────────
  conversations: [],
  setConversations: (conversations) => set({ conversations }),
  upsertConversation: (convo) =>
    set((s) => {
      const existing = s.conversations.findIndex((c) => c.id === convo.id);
      if (existing >= 0) {
        const updated = [...s.conversations];
        updated[existing] = { ...updated[existing], ...convo };
        return { conversations: updated };
      }
      return { conversations: [convo, ...s.conversations] };
    }),
  updateConversation: (id, patch) => {
    // Existing state — used to detect transitions for mirroring
    const prev = get().conversations.find((c) => c.id === id);

    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
    fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});

    // Mirror to LinkedIn if enabled and a relevant field changed
    const mirror = useAuthStore.getState().mirrorToLinkedIn;
    if (mirror && prev) {
      if (patch.isStarred !== undefined && patch.isStarred !== prev.isStarred) {
        fireMirror(patch.isStarred ? 'star' : 'unstar', id);
      }
      if (patch.status !== undefined && patch.status !== prev.status) {
        if (patch.status === 'archived') fireMirror('archive', id);
        else if (prev.status === 'archived') fireMirror('unarchive', id);
        if (patch.status === 'unread' && prev.status !== 'unread') fireMirror('unread', id);
        else if (patch.status === 'read' && prev.status !== 'read') fireMirror('read', id);
      }
    }
  },
  deleteConversation: (id: string) => {
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeConversationId: s.activeConversationId === id ? null : s.activeConversationId,
      messages: Object.fromEntries(
        Object.entries(s.messages).filter(([k]) => k !== id),
      ),
    }));
    fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    if (useAuthStore.getState().mirrorToLinkedIn) fireMirror('delete', id);
  },

  // ─── Active conversation ────────────────────────────────────────────────────
  activeConversationId: null,
  setActiveConversationId: (id) => set({ activeConversationId: id }),

  // ─── Bulk selection ────────────────────────────────────────────────────────
  // Selection is in-memory only — it intentionally resets on page reload.
  selectedIds: new Set<string>(),
  toggleSelected: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),
  setSelected: (ids) =>
    set({ selectedIds: ids instanceof Set ? new Set(ids) : new Set(ids) }),
  clearSelection: () => set({ selectedIds: new Set<string>() }),
  selectAll: () => {
    const s = get();
    const start = s.currentRoleOnly && s.currentRoleStart ? new Date(s.currentRoleStart) : null;
    const visible = filterConversations(s.conversations, s.activeFilter, s.searchQuery, start);
    set({ selectedIds: new Set(visible.map((c) => c.id)) });
  },
  bulkUpdate: async (patch) => {
    const ids = Array.from(get().selectedIds);
    if (ids.length === 0) return;
    const update = get().updateConversation;

    // Throttle: run in waves of up to 10 concurrent requests.
    const BATCH = 10;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      // updateConversation is sync (it fires PATCH and returns) — but we
      // still batch in waves so we don't queue 1000 fetches in one tick.
      slice.forEach((id) => update(id, patch));
      // Yield to the event loop between waves so the UI stays responsive
      // and the browser can flush the fetches.
      if (i + BATCH < ids.length) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    set({ selectedIds: new Set<string>() });
  },
  bulkDelete: async () => {
    const ids = Array.from(get().selectedIds);
    if (ids.length === 0) return;
    const del = get().deleteConversation;
    const BATCH = 10;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      slice.forEach((id) => del(id));
      if (i + BATCH < ids.length) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    set({ selectedIds: new Set<string>() });
  },

  // ─── Messages (in-memory cache) ────────────────────────────────────────────
  messages: {},
  setMessages: (conversationId, messages) =>
    set((s) => ({ messages: { ...s.messages, [conversationId]: messages } })),
  loadMessages: async (conversationId) => {
    if (!conversationId) return;
    // Always refetch — DB is the source of truth and may have new messages
    try {
      const r = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
      if (!r.ok) return;
      const data = await r.json();
      const items: Message[] = Array.isArray(data?.messages) ? data.messages : [];
      set((s) => ({ messages: { ...s.messages, [conversationId]: items } }));
    } catch {
      // swallow — UI will show "no messages loaded yet"
    }
  },

  // ─── UI state ───────────────────────────────────────────────────────────────
  activeFilter: 'all',
  setActiveFilter: (f) => set({ activeFilter: f }),
  sidebarCollapsed: false,
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  composeOpen: false,
  setComposeOpen: (v) => set({ composeOpen: v }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  // Current-role toggle. Hydrated lazily — initial values from localStorage,
  // server-side role start date populated by the sidebar via /api/patterns.
  currentRoleOnly: storage.currentRoleOnly.get(),
  setCurrentRoleOnly: (v) => {
    storage.currentRoleOnly.set(v);
    set({ currentRoleOnly: v });
  },
  currentRoleStart: null,
  currentRoleLabel: null,
  setCurrentRoleMeta: (start, label) => set({ currentRoleStart: start, currentRoleLabel: label }),

  // ─── Labels ─────────────────────────────────────────────────────────────────
  labels: [],
  addLabel: (label) => {
    // Upsert into the local store — replace if same id, else append.
    set((s) => {
      const idx = s.labels.findIndex((l) => l.id === label.id);
      const next = s.labels.slice();
      if (idx >= 0) next[idx] = label;
      else next.push(label);
      return { labels: next };
    });
    fetch('/api/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(label),
    }).catch(() => {});
  },
  removeLabel: (id) => {
    set((s) => ({
      labels: s.labels.filter((l) => l.id !== id),
      // Strip from local conversation labels so the chip disappears immediately
      conversations: s.conversations.map((c) =>
        c.labels.includes(id) ? { ...c, labels: c.labels.filter((l) => l !== id) } : c,
      ),
    }));
    fetch(`/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  },

  // ─── Snippets ───────────────────────────────────────────────────────────────
  snippets: [],
  addSnippet: (snippet) => {
    set((s) => ({ snippets: [...s.snippets, snippet] }));
    fetch('/api/snippets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snippet),
    }).catch(() => {});
  },
  removeSnippet: (id) => {
    set((s) => ({ snippets: s.snippets.filter((sn) => sn.id !== id) }));
    fetch(`/api/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  },

  // ─── Sync ───────────────────────────────────────────────────────────────────
  syncStatus: 'idle',
  setSyncStatus: (s) => set({ syncStatus: s }),
  lastSyncedAt: null,
  setLastSyncedAt: (t) => set({ lastSyncedAt: t }),

  // ─── Bootstrap ──────────────────────────────────────────────────────────────
  hasLoaded: false,
  loadFromServer: async () => {
    try {
      const [convsRes, labelsRes, snippetsRes] = await Promise.all([
        fetch('/api/conversations').then((r) => (r.ok ? r.json() : { conversations: [] })),
        fetch('/api/labels').then((r) => (r.ok ? r.json() : { labels: [] })),
        fetch('/api/snippets').then((r) => (r.ok ? r.json() : { snippets: [] })),
      ]);

      const conversations: Conversation[] = Array.isArray(convsRes?.conversations)
        ? convsRes.conversations
        : [];

      let labels: Label[] = Array.isArray(labelsRes?.labels) ? labelsRes.labels : [];
      let snippets: Snippet[] = Array.isArray(snippetsRes?.snippets) ? snippetsRes.snippets : [];

      // Seed defaults on first run.
      if (labels.length === 0) {
        await fetch('/api/labels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labels: DEFAULT_LABELS }),
        }).catch(() => {});
        labels = DEFAULT_LABELS;
      }
      if (snippets.length === 0) {
        await fetch('/api/snippets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snippets: DEFAULT_SNIPPETS }),
        }).catch(() => {});
        snippets = DEFAULT_SNIPPETS;
      }

      set({ conversations, labels, snippets, hasLoaded: true });
    } catch (e) {
      console.error('[loadFromServer] failed', e);
    }
  },

  // ─── Auto-refresh ───────────────────────────────────────────────────────────
  // Poll /api/state every 30s. If the conversation index size grew compared to
  // our local store, pull fresh conversations via loadFromServer.
  startAutoRefresh: () => {
    let cancelled = false;
    // Track the latest known timestamps so we detect both NEW conversations
    // (count grew) AND new messages on existing conversations (lastMessageAt
    // moved forward).
    let lastSeenMap: Record<string, number> = {};
    for (const c of get().conversations) {
      lastSeenMap[c.id] = new Date(c.lastMessageAt).getTime();
    }

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await fetch('/api/state');
        if (!r.ok) return;
        const j = await r.json();
        const serverMap: Record<string, number> = j?.conversationsByUrn || {};

        // Detect: new conversation OR existing one's timestamp advanced
        let changed = false;
        for (const [id, ts] of Object.entries(serverMap)) {
          const known = lastSeenMap[id];
          if (known === undefined || ts > known) {
            changed = true;
            break;
          }
        }

        if (changed) {
          // Capture the currently-active conversation before reload so we can
          // refresh its messages if its lastMessageAt advanced.
          const activeId = get().activeConversationId;
          const activeAdvanced =
            !!activeId &&
            (serverMap[activeId] ?? 0) > (lastSeenMap[activeId] ?? 0);

          await get().loadFromServer();

          // If the open thread got new activity, refresh its messages.
          // loadMessages atomically replaces the cache — don't clear first.
          if (activeAdvanced && activeId) {
            await get().loadMessages(activeId);
          }

          // Update baseline from the now-fresh store state
          const fresh: Record<string, number> = {};
          for (const c of get().conversations) {
            fresh[c.id] = new Date(c.lastMessageAt).getTime();
          }
          lastSeenMap = fresh;
        } else {
          // Keep baseline in sync in case the store grew via other paths
          lastSeenMap = serverMap;
        }
      } catch {
        // App/route handler unreachable — try again next tick
      }
    };

    // Run once immediately so we don't wait 30s after mount
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  },
}));

// Keep the main store's `auth` slice in sync with the persisted authStore.
useAuthStore.subscribe((s) => useStore.setState({ auth: s.auth }));

// Expose for debugging from the browser console
if (typeof window !== 'undefined') {
  (window as unknown as { useStore: typeof useStore }).useStore = useStore;
}
