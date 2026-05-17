// Central typed wrapper around localStorage. Every persisted-client-state
// key in InboxPro lives here so we can grep one place to see what's
// stashed in the user's browser.
//
// NOT covered: the early-paint script in `src/app/layout.tsx`, which reads
// `inbox-theme` and `inbox-accent-rgb` synchronously before the JS bundle
// loads. Those calls must stay raw — keep them in sync with the keys here.

type Theme = 'light' | 'dark';
export type SidebarMode = 'auto' | 'expanded' | 'collapsed';

const KEYS = {
  theme: 'inbox-theme',
  accentRgb: 'inbox-accent-rgb',
  onboarded: 'inboxpro-onboarded',
  onboardingStep: 'inboxpro-onboarding-step',
  sidebarMode: 'inboxpro-sidebar-mode',
  currentRoleOnly: 'inboxpro-current-role-only',
  seenTabNotice: 'inboxpro-seen-tab-notice',
  notificationsMuted: 'inboxpro-notifications-desktop-muted',
  notificationsSeenIds: 'inboxpro-notifications-seen-ids',
  columnWidth: (id: string) => `inboxpro-col-${id}`,
} as const;

// Safe wrappers — every call is guarded against SSR and storage-disabled
// browsers. Throws are swallowed; getters fall back to the default.
function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, value); } catch {}
}

function safeRemove(key: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(key); } catch {}
}

// ─── Typed accessors ──────────────────────────────────────────────────────

export const storage = {
  theme: {
    get(): Theme | null {
      const v = safeGet(KEYS.theme);
      return v === 'dark' || v === 'light' ? v : null;
    },
    set(v: Theme) { safeSet(KEYS.theme, v); },
  },

  accentRgb: {
    get(): string | null { return safeGet(KEYS.accentRgb); },
    set(v: string) { safeSet(KEYS.accentRgb, v); },
  },

  onboarded: {
    get(): boolean { return safeGet(KEYS.onboarded) === '1'; },
    set(v: boolean) { safeSet(KEYS.onboarded, v ? '1' : '0'); },
  },

  onboardingStep: {
    get(): number {
      const raw = safeGet(KEYS.onboardingStep);
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    },
    set(v: number) { safeSet(KEYS.onboardingStep, String(v)); },
    clear() { safeRemove(KEYS.onboardingStep); },
  },

  sidebarMode: {
    get(): SidebarMode | null {
      const v = safeGet(KEYS.sidebarMode);
      return v === 'auto' || v === 'expanded' || v === 'collapsed' ? v : null;
    },
    set(v: SidebarMode) { safeSet(KEYS.sidebarMode, v); },
  },

  currentRoleOnly: {
    get(): boolean { return safeGet(KEYS.currentRoleOnly) === '1'; },
    set(v: boolean) { safeSet(KEYS.currentRoleOnly, v ? '1' : '0'); },
  },

  seenTabNotice: {
    get(): boolean { return safeGet(KEYS.seenTabNotice) === '1'; },
    set(v: boolean) { safeSet(KEYS.seenTabNotice, v ? '1' : '0'); },
  },

  notificationsMuted: {
    get(): boolean { return safeGet(KEYS.notificationsMuted) === '1'; },
    set(v: boolean) { safeSet(KEYS.notificationsMuted, v ? '1' : '0'); },
  },

  notificationsSeenIds: {
    get(): string[] {
      const raw = safeGet(KEYS.notificationsSeenIds);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
      } catch { return []; }
    },
    set(v: string[]) { safeSet(KEYS.notificationsSeenIds, JSON.stringify(v)); },
  },

  columnWidth: {
    get(id: string): number | null {
      const raw = safeGet(KEYS.columnWidth(id));
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    },
    set(id: string, width: number) { safeSet(KEYS.columnWidth(id), String(width)); },
  },
} as const;
