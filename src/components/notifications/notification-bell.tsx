'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BellOff, MessageSquare, Sparkles, Briefcase, Clock, CheckCheck, X, Trash2 } from 'lucide-react';
import { useStore } from '@/store';
import { cn } from '@/lib/cn';
import { storage } from '@/lib/storage';
import { formatDistanceToNowStrict } from 'date-fns';

type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  conversationId: string | null;
  contactId: string | null;
  read: boolean;
  dismissed: boolean;
  createdAt: string;
  meta: Record<string, unknown> | null;
};

const KIND_ICON: Record<string, typeof MessageSquare> = {
  'new-message': MessageSquare,
  'ai-signal': Sparkles,
  'job-change': Briefcase,
  'follow-up-due': Clock,
  'system': Bell,
};

const KIND_TINT: Record<string, string> = {
  'new-message': 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]',
  'ai-signal': 'text-[var(--color-success)] bg-[var(--color-success)]/15',
  'job-change': 'text-[#7C3AED] bg-[#7C3AED]/15',
  'follow-up-due': 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]',
  'system': 'text-[var(--color-text-tertiary)] bg-[var(--color-card-hover)]',
};

// Mute toggle + seen-ids persist across sessions via storage.ts so the
// poll doesn't re-fire desktop alerts that already showed once.
function loadSeenIds(): Set<string> {
  return new Set(storage.notificationsSeenIds.get());
}
function saveSeenIds(ids: Set<string>): void {
  // Cap to most recent 500 IDs to keep the storage small.
  storage.notificationsSeenIds.set([...ids].slice(-500));
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const setActiveConversationId = useStore((s) => s.setActiveConversationId);
  const setActiveFilter = useStore((s) => s.setActiveFilter);
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Track which notification IDs we've already mirrored to desktop so a
  // poll doesn't re-fire the same alert.
  const seenIdsRef = useRef<Set<string>>(new Set());
  // Popover position computed on open from the bell's bounding rect.
  // We portal to document.body and use position: fixed so the popover
  // escapes the sidebar's overflow-hidden clip.
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [muted, setMuted] = useState(false);

  // Hydrate mute state from localStorage so the toggle UI is correct on mount.
  useEffect(() => { setMuted(storage.notificationsMuted.get()); }, []);
  function toggleMute() {
    const next = !muted;
    setMuted(next);
    storage.notificationsMuted.set(next);
  }

  // Browser notification permission. Tracked in state so the popover header
  // can show "Enable" / "Blocked" / mute-toggle depending on state. Chrome
  // ignores requestPermission() unless tied to a real user click, so we
  // expose an explicit button rather than auto-popping on mount.
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('unsupported');
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission);
  }, []);
  async function requestPermission() {
    if (!('Notification' in window)) return;
    try {
      const r = await Notification.requestPermission();
      setPermission(r);
    } catch {
      // user denied via system dialog → state updates on next mount
    }
  }

  // Hydrate seen-IDs from localStorage on mount.
  useEffect(() => { seenIdsRef.current = loadSeenIds(); }, []);

  function fireDesktopAlert(n: Notification) {
    if (storage.notificationsMuted.get()) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) {
      // User is actively in the app — bell badge is enough. Don't ping.
      return;
    }
    try {
      const dn = new Notification(n.title, {
        body: n.body,
        tag: `inboxpro-${n.id}`, // dedupe at the OS level
        icon: '/favicon.ico',
      });
      dn.onclick = () => {
        window.focus();
        if (n.conversationId) {
          setActiveFilter('all');
          setActiveConversationId(n.conversationId);
        }
        dn.close();
      };
    } catch {
      // Some browsers throw if called from an unfocused/iframe context.
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/notifications?limit=50');
      const d = await r.json();
      const list: Notification[] = d.notifications ?? [];
      setItems(list);
      setUnread(d.unreadCount ?? 0);

      // Mirror unread items we haven't fired desktop alerts for yet.
      // First poll after mount: seed the seen set with everything currently
      // visible so we don't blast historical items as if they were new.
      const seen = seenIdsRef.current;
      if (seen.size === 0) {
        for (const n of list) seen.add(n.id);
        saveSeenIds(seen);
      } else {
        for (const n of list) {
          if (n.read || n.dismissed) continue;
          if (seen.has(n.id)) continue;
          fireDesktopAlert(n);
          seen.add(n.id);
        }
        saveSeenIds(seen);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial fetch + 30s poll for the badge count (cheap query).
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  // Refresh whenever opened so the user sees fresh items immediately.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!popRef.current || !btnRef.current) return;
      if (popRef.current.contains(e.target as Node)) return;
      if (btnRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Compute popover position relative to the bell button. Re-runs on open,
  // window resize, and scroll so the popover tracks the button if the
  // page reflows underneath it.
  useEffect(() => {
    if (!open) return;
    function place() {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      const POP_WIDTH = 360;
      const MARGIN = 8;
      const top = rect.bottom + 6;
      // Anchor the popover's LEFT edge to the bell's right edge, but clamp
      // so it never overflows the viewport on either side.
      let left = rect.left;
      if (left + POP_WIDTH + MARGIN > window.innerWidth) {
        left = Math.max(MARGIN, window.innerWidth - POP_WIDTH - MARGIN);
      }
      setPopPos({ top, left });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  async function markRead(id: string) {
    setItems((arr) => arr.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnread((u) => Math.max(0, u - 1));
    await fetch(`/api/notifications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: true }),
    });
  }

  async function markAllRead() {
    setItems((arr) => arr.map((n) => ({ ...n, read: true })));
    setUnread(0);
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark-all-read' }),
    });
  }

  // Track which notification IDs are mid-exit so they can render with
  // `row-out` class instead of being unmounted immediately.
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  async function dismissOne(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    e?.preventDefault();
    const item = items.find((n) => n.id === id);
    if (item && !item.read) setUnread((u) => Math.max(0, u - 1));
    // Play exit animation, then actually remove from state.
    setLeaving((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setItems((arr) => arr.filter((n) => n.id !== id));
      setLeaving((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }, 240);
    await fetch(`/api/notifications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismissed: true }),
    });
  }

  async function clearAll() {
    if (items.length === 0) return;
    const ids = items.map((n) => n.id);
    setItems([]);
    setUnread(0);
    // Soft delete (dismissed=true) — keeps row history for now. Parallel
    // PATCHes are fine; backend is cheap.
    await Promise.all(ids.map((id) =>
      fetch(`/api/notifications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed: true }),
      })
    ));
  }

  function onItemClick(n: Notification) {
    if (!n.read) markRead(n.id);
    if (n.conversationId) {
      setActiveFilter('all');
      setActiveConversationId(n.conversationId);
      setOpen(false);
    }
  }

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'relative w-7 h-7 flex items-center justify-center rounded-md',
          'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)]',
        )}
        style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-[var(--color-accent)] text-white text-[9px] font-semibold leading-none flex items-center justify-center tabular-nums">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && mounted && popPos && createPortal(
        <div
          ref={popRef}
          className="popover-in fixed w-[360px] max-h-[480px] bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl overflow-hidden z-[60] flex flex-col"
          style={{ top: popPos.top, left: popPos.left, boxShadow: 'var(--shadow-raised)', transformOrigin: 'top right' }}
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-hairline)]">
            <span className="eyebrow flex items-center gap-1.5">
              <Bell className="w-3 h-3" /> Notifications
            </span>
            <div className="flex items-center gap-2">
              {permission === 'default' && (
                <button
                  onClick={requestPermission}
                  className="text-[11px] font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] inline-flex items-center gap-1"
                  title="Allow browser desktop alerts when InboxPro is in the background"
                >
                  <Bell className="w-3 h-3" /> Enable desktop alerts
                </button>
              )}
              {permission === 'denied' && (
                <span
                  className="text-[10.5px] text-[var(--color-danger)] inline-flex items-center gap-1"
                  title="Re-enable in your browser site settings (lock icon → Notifications → Allow)"
                >
                  <BellOff className="w-3 h-3" /> Blocked
                </span>
              )}
              {permission === 'granted' && (
                <>
                  <button
                    onClick={() => {
                      try {
                        const n = new Notification('InboxPro test alert', {
                          body: 'If you see this, desktop notifications are working.',
                          icon: '/favicon.ico',
                          tag: `inboxpro-test-${Date.now()}`,
                        });
                        n.onclick = () => { window.focus(); n.close(); };
                      } catch (e) {
                        console.error('test alert failed', e);
                      }
                    }}
                    className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] inline-flex items-center gap-1"
                    title="Fire a sample desktop alert right now"
                  >
                    Test
                  </button>
                  <button
                    onClick={toggleMute}
                    className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] inline-flex items-center gap-1"
                    title={muted ? 'Desktop alerts paused — click to enable' : 'Pause desktop alerts (badge keeps updating)'}
                  >
                    {muted ? <BellOff className="w-3 h-3" /> : <Bell className="w-3 h-3" />}
                    {muted ? 'Muted' : 'Desktop'}
                  </button>
                </>
              )}
              {items.some((n) => !n.read) && (
                <button
                  onClick={markAllRead}
                  className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] inline-flex items-center gap-1"
                >
                  <CheckCheck className="w-3 h-3" /> Mark all read
                </button>
              )}
              {items.length > 0 && (
                <button
                  onClick={clearAll}
                  className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] inline-flex items-center gap-1"
                  title="Dismiss all visible notifications"
                >
                  <Trash2 className="w-3 h-3" /> Clear all
                </button>
              )}
            </div>
          </div>
          <div className="row-in-stagger overflow-y-auto flex-1">
            {loading && items.length === 0 ? (
              <div className="px-4 py-6 text-[12px] text-[var(--color-text-tertiary)] text-center">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-10 text-[12px] text-[var(--color-text-tertiary)] text-center">
                Nothing yet. New replies, AI signals, and job changes will show up here.
              </div>
            ) : (
              items.map((n) => {
                const Icon = KIND_ICON[n.kind] ?? Bell;
                const tint = KIND_TINT[n.kind] ?? KIND_TINT['system'];
                return (
                  <div
                    key={n.id}
                    className={cn(
                      'group relative border-b border-[var(--color-hairline)] last:border-0 hover:bg-[var(--color-card-hover)]',
                      !n.read && 'bg-[var(--color-accent-soft)]/40',
                      leaving.has(n.id) && 'row-out',
                    )}
                  >
                    <button
                      onClick={() => onItemClick(n)}
                      className="w-full text-left px-4 py-3 flex items-start gap-3 pr-9"
                    >
                      <span className={cn('w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0', tint)}>
                        <Icon className="w-3.5 h-3.5" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn('text-[12.5px] truncate', !n.read ? 'font-semibold text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]')}>
                            {n.title}
                          </span>
                          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] flex-shrink-0" />}
                        </div>
                        <div className="text-[11.5px] text-[var(--color-text-tertiary)] line-clamp-2 mt-0.5">
                          {n.body}
                        </div>
                        <div className="text-[10.5px] text-[var(--color-text-muted)] mt-1">
                          {formatDistanceToNowStrict(new Date(n.createdAt), { addSuffix: true })}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={(e) => dismissOne(n.id, e)}
                      className="absolute top-2.5 right-2 w-6 h-6 flex items-center justify-center rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)] opacity-0 group-hover:opacity-100"
                      style={{ transition: 'opacity 120ms var(--ease-out-quart)' }}
                      title="Dismiss"
                      aria-label="Dismiss notification"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
