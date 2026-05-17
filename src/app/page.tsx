'use client';
import { useEffect, useRef, useState } from 'react';
import { Sidebar } from '@/components/sidebar/sidebar';
import { ConversationList } from '@/components/conversation-list/conversation-list';
import { MessageThread } from '@/components/message-thread/message-thread';
import { ContactDetails } from '@/components/contact-details/contact-details';
import { QueuePanel } from '@/components/queue/queue-panel';
import { SettingsPanel } from '@/components/compose/settings-panel';
import { AnalyticsPanel } from '@/components/analytics/analytics-panel';
import { DiagnosticsPanel } from '@/components/diagnostics/diagnostics-panel';
import { ContactsPanel } from '@/components/contacts/contacts-panel';
import { TasksPanel } from '@/components/tasks/tasks-panel';
import { ReviewPanel } from '@/components/review/review-panel';
import { WelcomePanel } from '@/components/welcome/welcome-panel';
import { OnboardingWizard } from '@/components/welcome/onboarding-wizard';
import { useStore } from '@/store';
import { storage } from '@/lib/storage';

export default function Home() {
  const {
    activeFilter,
    activeConversationId,
    updateConversation,
    conversations,
    setLastSyncedAt,
    loadFromServer,
    startAutoRefresh,
  } = useStore();
  const [importBanner, setImportBanner] = useState<string | null>(null);
  const convosRef = useRef(conversations);
  convosRef.current = conversations;

  // Bootstrap from DB on mount
  useEffect(() => {
    loadFromServer();
  }, [loadFromServer]);

  // Listen for instant-update broadcasts from the extension (fired when
  // LinkedIn's realtime WebSocket pushes a new-message event).
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type === 'inboxpro-thread-updated') {
        // Reload conversations to pick up new lastMessage/lastMessageAt, AND
        // refresh the active thread's messages if it's the affected one.
        // loadMessages atomically replaces — no need to clear first.
        loadFromServer();
        const activeId = useStore.getState().activeConversationId;
        if (activeId && activeId === ev.data.urn) {
          useStore.getState().loadMessages(activeId);
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadFromServer]);

  // Poll /api/state to pick up data the extension pushes in the background.
  useEffect(() => {
    const stop = startAutoRefresh();
    return stop;
  }, [startAutoRefresh]);

  // Auto-classify trickle: every 5 min, fire-and-forget classify the
  // SMALL backlog of unclassified threads (cap 25). Skips bulk backfill —
  // user has to use Diagnostics for a full pass. Keeps fresh conversations
  // labeled within minutes of arrival without surprise spend.
  useEffect(() => {
    const AUTO_CHUNK = 25;
    let running = false;
    async function trickle() {
      if (running) return;
      try {
        const cr = await fetch('/api/ai/classify-all');
        if (!cr.ok) return;
        const counts = await cr.json();
        const pending = counts?.pending ?? 0;
        if (pending === 0 || pending > AUTO_CHUNK) return; // skip if too many to be a trickle
        running = true;
        const list = await fetch('/api/ai/classify-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: AUTO_CHUNK }),
        }).then((r) => (r.ok ? r.json() : null));
        const ids = list?.ids ?? [];
        if (ids.length === 0) return;
        await fetch('/api/ai/classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationIds: ids }),
        });
        // Pull fresh data so the new labels render
        loadFromServer();
      } catch {
        // silent — this is opportunistic background work
      } finally {
        running = false;
      }
    }
    const initial = setTimeout(trickle, 10_000); // 10s after mount
    const interval = setInterval(trickle, 5 * 60 * 1000); // every 5 min
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [loadFromServer]);

  // Handle data arriving via URL hash (legacy bookmarklet) or from the extension.
  // The transform now happens server-side in /api/import — we just POST raw data.
  useEffect(() => {
    async function applyImport(
      rawConvs: Array<Record<string, unknown>>,
      rawMsgs: Record<string, unknown[]> = {},
      entities: Record<string, unknown> = {},
      myProfileUrn = '',
    ) {
      try {
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversations: rawConvs,
            messages: rawMsgs,
            entities,
            myProfileUrn,
          }),
        });
        if (!res.ok) {
          console.error('[import] POST failed', await res.text().catch(() => ''));
          return;
        }
        const data = await res.json();
        await loadFromServer();
        setLastSyncedAt(new Date().toISOString());
        setImportBanner(
          `✓ Loaded ${data.conversations ?? 0} conversations${data.messages ? ` · ${data.messages} messages` : ''}`,
        );
        setTimeout(() => setImportBanner(null), 4000);
      } catch (e) {
        console.error('applyImport failed', e);
      }
    }

    function handleHash() {
      const hash = window.location.hash;
      if (!hash.startsWith('#li-import=')) return;
      try {
        const encoded = hash.slice('#li-import='.length);
        const json = decodeURIComponent(escape(atob(encoded)));
        const raw: Array<Record<string, unknown>> = JSON.parse(json);
        applyImport(raw);
        history.replaceState(null, '', window.location.pathname);
      } catch (e) {
        console.error('Failed to parse import', e);
      }
    }

    handleHash();
    window.addEventListener('hashchange', handleHash);

    // The extension now POSTs directly to /api/import — no need to pull on
    // ?synced=1 anymore, but reload from DB to pick up the new data.
    const params = new URLSearchParams(window.location.search);
    if (params.get('synced') === '1') {
      loadFromServer();
      setLastSyncedAt(new Date().toISOString());
      history.replaceState(null, '', window.location.pathname);
    }

    // Notification click handler — extension opens us with ?conv=<entityUrn>
    const convId = params.get('conv');
    if (convId) {
      useStore.getState().setActiveConversationId(convId);
      // Strip the param without reloading
      const url = new URL(window.location.href);
      url.searchParams.delete('conv');
      history.replaceState(null, '', url.pathname + url.search);
    }

    return () => window.removeEventListener('hashchange', handleHash);
  }, [loadFromServer, setLastSyncedAt]);

  // Auth is now handled by the Chrome extension (you log into LinkedIn in your
  // browser, the extension uses that session). No need to gate the app on a
  // pasted cookie anymore.

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!activeConversationId) return;

      const convo = convosRef.current.find((c) => c.id === activeConversationId);
      switch (e.key.toLowerCase()) {
        case 's':
          e.preventDefault();
          if (convo) updateConversation(activeConversationId, { isStarred: !convo.isStarred });
          break;
        case 'e':
          e.preventDefault();
          updateConversation(activeConversationId, { status: 'archived' });
          break;
        case 'h':
          e.preventDefault();
          updateConversation(activeConversationId, {
            status: 'snoozed',
            snoozedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          });
          break;
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [activeConversationId, updateConversation]);

  // Desktop notifications for due follow-ups. Every 5 minutes (plus once on
  // mount), scan conversations for any whose `followUpAt` has passed but
  // hasn't been alerted yet — track the followUpAt timestamps we've already
  // notified on so we don't spam the user.
  const [alertedFollowUps, setAlertedFollowUps] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    // Permission is now requested explicitly from the bell popover header.
    // We don't auto-prompt here (Chrome ignores non-gesture requests anyway).

    function checkFollowUps() {
      if (Notification.permission !== 'granted') return;
      const now = Date.now();
      const newlyAlerted: string[] = [];
      for (const c of convosRef.current) {
        if (!c.followUpAt) continue;
        const ts = new Date(c.followUpAt).getTime();
        if (isNaN(ts) || ts > now) continue;
        // Tiered notifications: desktop ping ONLY for high-signal
        // commitments. Soft-kind follow-ups land in the bell / Tasks but
        // don't punch the user on the shoulder. Manual follow-ups always
        // notify (the user explicitly set them).
        const kind = (c as { followUpKind?: string | null }).followUpKind;
        const isCommitment = c.followUpSource === 'manual' || kind === 'commitment';
        if (!isCommitment) continue;
        // Key on conversation id + followUpAt — if user re-sets, key changes.
        const key = `${c.id}::${c.followUpAt}`;
        if (alertedFollowUps.has(key)) continue;
        newlyAlerted.push(key);
        const name = c.participants[0]?.name ?? 'Conversation';
        // Body shows the actual phrase that triggered the follow-up so
        // the user can sanity-check at a glance ("oh, they said 'ping me
        // in Q1' — that's why this is firing").
        const reason = c.followUpReason;
        const body = reason
          ? `“${reason.slice(0, 140)}”`
          : (c.lastMessage?.slice(0, 140) || 'Time to follow up.');
        try {
          const n = new Notification(`Follow up: ${name}`, {
            body,
            tag: `inboxpro-followup-${c.id}`,
          });
          n.onclick = () => {
            window.focus();
            // Force navigation back to the inbox view AND open the conv.
            // Without this, clicking a notification while on Settings /
            // Drafts / Analytics silently changes the active conv but
            // keeps the user in the other view — feels like "nothing
            // happened" or even a broken navigation.
            const store = useStore.getState();
            store.setActiveFilter('all');
            store.setActiveConversationId(c.id);
            n.close();
          };
        } catch {
          // Some browsers throw if permission was revoked mid-session.
        }
      }
      if (newlyAlerted.length > 0) {
        setAlertedFollowUps((prev) => {
          const next = new Set(prev);
          for (const k of newlyAlerted) next.add(k);
          return next;
        });
      }
    }

    // Run once shortly after mount, then every 5 minutes.
    const initialId = setTimeout(checkFollowUps, 5_000);
    const intervalId = setInterval(checkFollowUps, 5 * 60 * 1000);
    return () => {
      clearTimeout(initialId);
      clearInterval(intervalId);
    };
  }, [alertedFollowUps]);

  const isSettings = activeFilter === 'settings';
  const isAnalytics = activeFilter === 'analytics';
  const isDiagnostics = activeFilter === 'diagnostics';
  const isQueue = activeFilter === 'queue';
  const isContacts = activeFilter === 'contacts';
  const isTasks = activeFilter === 'tasks';
  const isReview = activeFilter === 'review';
  // Show the full onboarding wizard for first-time users (no convs synced AND
  // they haven't already finished onboarding). Falls back to the simpler
  // WelcomePanel only if they explicitly cleared their data later.
  const [onboarded, setOnboarded] = useState(true);
  const [previewWizard, setPreviewWizard] = useState(false);
  useEffect(() => {
    setOnboarded(storage.onboarded.get());
    // Allow ?onboard=1 in the URL to preview the wizard without wiping data
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('onboard') === '1') setPreviewWizard(true);
    } catch {}
  }, []);
  const showOnboarding = previewWizard ||
    (conversations.length === 0 && !onboarded && !isSettings && !isAnalytics && !isDiagnostics && !isQueue && !isContacts && !isTasks && !isReview);
  const showWelcome = !previewWizard && conversations.length === 0 && onboarded && !isSettings && !isAnalytics && !isDiagnostics && !isQueue && !isContacts && !isTasks && !isReview;

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg)] p-3 gap-3">
      <Sidebar />
      <div className="flex flex-1 min-w-0 overflow-hidden flex-col gap-3">
        {importBanner && (
          <div className="card px-4 py-2 text-[12px] font-medium text-[var(--color-accent-fg)] bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-center flex-shrink-0">
            {importBanner}
          </div>
        )}
        <div className="flex flex-1 min-w-0 overflow-hidden gap-3">
          {/* Each panel branch fade-ins on mount. The `key` forces React
              to treat each branch's div as a distinct element rather than
              reusing the DOM node across branches — without it the wrapper
              never unmounts and the animation never re-fires. */}
          {isTasks ? (
            <div key="tasks" className="view-fade-in flex flex-1 min-w-0"><TasksPanel /></div>
          ) : isReview ? (
            <div key="review" className="view-fade-in flex flex-1 min-w-0"><ReviewPanel /></div>
          ) : isQueue ? (
            <div key="queue" className="view-fade-in flex flex-1 min-w-0"><QueuePanel /></div>
          ) : isContacts ? (
            <div key="contacts" className="view-fade-in flex flex-1 min-w-0"><ContactsPanel /></div>
          ) : isAnalytics ? (
            <div key="analytics" className="view-fade-in flex flex-1 min-w-0"><AnalyticsPanel /></div>
          ) : isDiagnostics ? (
            <div key="diagnostics" className="view-fade-in flex flex-1 min-w-0"><DiagnosticsPanel /></div>
          ) : isSettings ? (
            <div key="settings" className="view-fade-in flex flex-1 min-w-0"><SettingsPanel /></div>
          ) : showOnboarding ? (
            <OnboardingWizard
              preview={previewWizard}
              onComplete={() => {
                setPreviewWizard(false);
                setOnboarded(true);
              }}
            />
          ) : showWelcome ? (
            <WelcomePanel />
          ) : (
            <>
              <ConversationList />
              <MessageThread />
              <ContactDetails />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
