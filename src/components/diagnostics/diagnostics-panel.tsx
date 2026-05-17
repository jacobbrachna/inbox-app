'use client';
import { useEffect, useState } from 'react';
import { Activity, Database, RefreshCw, Trash2, AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import { useExtensionReady } from '@/lib/use-extension-ready';

interface Stats {
  convCount: number;
  msgCount: number;
  unread: number;
  archived: number;
  starred: number;
  withNotes: number;
  withFollowUp: number;
  orphanedPreviews: number;
  emptyParticipants: number;
  appState: {
    myProfileUrn: string | null;
    profileName: string | null;
    lastSyncedAt: string | null;
  };
}

interface LogEntry {
  t: string;
  src: string;
  ev: string;
  [k: string]: unknown;
}

function StatBox({
  label, value, color = 'gray', sub,
}: {
  label: string;
  value: string | number;
  color?: 'gray' | 'amber' | 'red' | 'green';
  sub?: string;
}) {
  const c = {
    gray: 'text-[var(--color-text-primary)]',
    amber: 'text-[var(--color-accent)]',
    red: 'text-[var(--color-danger)]',
    green: 'text-[var(--color-success)]',
  };
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-lg p-3">
      <div className="eyebrow">{label}</div>
      <div className={cn('text-[20px] font-semibold mt-1 tracking-tight', c[color])}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-text-tertiary)] mt-1">{sub}</div>}
    </div>
  );
}

function ResetButton({ onDone }: { onDone: () => void }) {
  const [showModal, setShowModal] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [msg, setMsg] = useState('');
  const [counts, setCounts] = useState<{
    conversations: number;
    messages: number;
    labels: number;
    snippets: number;
    notes: number;
  } | null>(null);

  // When modal opens, fetch counts so user sees what's actually at stake
  useEffect(() => {
    if (!showModal) return;
    setConfirmText('');
    fetch('/api/diagnostics')
      .then((r) => r.json())
      .then((d) => {
        setCounts({
          conversations: d.convCount ?? 0,
          messages: d.msgCount ?? 0,
          labels: d.labelCount ?? 0,
          snippets: d.snippetCount ?? 0,
          notes: d.withNotes ?? 0,
        });
      })
      .catch(() => setCounts(null));
  }, [showModal]);

  const canConfirm = confirmText === 'RESET' && state !== 'running';

  async function doReset() {
    if (!canConfirm) return;
    setState('running');
    setMsg('Wiping conversations and messages…');
    try {
      const r = await fetch('/api/reset?confirm=YES', { method: 'POST' });
      const d = await r.json();
      if (r.ok) {
        setMsg(`Wiped ${d.conversationsDeleted} convs · ${d.messagesDeleted} msgs. Run a fresh sync from the welcome screen.`);
        setState('done');
        onDone();
        setShowModal(false);
      } else {
        setMsg(`Failed: ${d.error}`);
        setState('idle');
      }
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : 'unknown'}`);
      setState('idle');
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => setShowModal(true)}
        disabled={state === 'running'}
        className="flex items-center gap-2 px-3 py-2 bg-[var(--color-danger)]/10 hover:bg-[var(--color-danger)]/20 border border-[var(--color-danger)]/40 text-[var(--color-danger)] text-[12px] font-semibold rounded-lg"
        style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
      >
        <Trash2 className="w-3.5 h-3.5" /> Reset DB
      </button>
      {msg && <span className="text-xs text-[var(--color-text-tertiary)]">{msg}</span>}

      {showModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => { if (state !== 'running') setShowModal(false); }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="menu-in card max-w-[440px] w-full mx-4 p-6"
            style={{ boxShadow: 'var(--shadow-raised)' }}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-[10px] bg-[var(--color-danger)]/10 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-[var(--color-danger)]" />
              </div>
              <div className="min-w-0">
                <h3 className="text-[16px] font-semibold text-[var(--color-text-primary)] tracking-tight">
                  Reset entire database?
                </h3>
                <p className="text-[12.5px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                  This permanently deletes everything below. You'll need to re-sync from scratch.
                </p>
              </div>
            </div>

            <div className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-lg px-4 py-3 mb-4">
              {counts ? (
                <ul className="text-[12.5px] text-[var(--color-text-secondary)] space-y-1">
                  <li className="flex justify-between">
                    <span>Conversations</span>
                    <span className="mono tabular-nums font-medium text-[var(--color-text-primary)]">{counts.conversations.toLocaleString()}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Messages</span>
                    <span className="mono tabular-nums font-medium text-[var(--color-text-primary)]">{counts.messages.toLocaleString()}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Conversations with notes</span>
                    <span className="mono tabular-nums font-medium text-[var(--color-text-primary)]">{counts.notes.toLocaleString()}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Labels</span>
                    <span className="mono tabular-nums font-medium text-[var(--color-text-primary)]">{counts.labels}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Snippets</span>
                    <span className="mono tabular-nums font-medium text-[var(--color-text-primary)]">{counts.snippets}</span>
                  </li>
                </ul>
              ) : (
                <span className="text-[12px] text-[var(--color-text-tertiary)]">Loading counts…</span>
              )}
            </div>

            <label className="block text-[12px] text-[var(--color-text-secondary)] mb-2">
              Type <code className="kbd mx-1">RESET</code> to confirm:
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="RESET"
              autoFocus
              className="input w-full mono tracking-wider mb-4"
              onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm) doReset(); }}
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowModal(false)}
                disabled={state === 'running'}
                className="px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] rounded-lg"
                style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
              >
                Cancel
              </button>
              <button
                onClick={doReset}
                disabled={!canConfirm}
                className={cn(
                  'px-4 py-1.5 text-[12.5px] font-semibold rounded-lg flex items-center gap-1.5',
                  canConfirm
                    ? 'bg-[var(--color-danger)] hover:opacity-90 text-white active:scale-[0.97]'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] cursor-not-allowed',
                )}
                style={{ transition: 'background-color 140ms var(--ease-out-quart), transform 80ms var(--ease-out-quart)' }}
              >
                {state === 'running' ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Wiping…
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    Permanently delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function DiagnosticsPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const bridgeReady = useExtensionReady();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [liSyncState, setLiSyncState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [liSyncMsg, setLiSyncMsg] = useState('');
  const [classifyState, setClassifyState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [classifyProgress, setClassifyProgress] = useState({ done: 0, total: 0, labels: 0, review: 0 });
  const [classifyError, setClassifyError] = useState<string | null>(null);
  const [classifyCounts, setClassifyCounts] = useState<{ eligible: number; pending: number } | null>(null);
  const loadFromServer = useStore((s) => s.loadFromServer);

  async function loadAll() {
    // Load each endpoint independently — if one fails (e.g. /api/diagnostics
    // 500s on a schema issue), the other should still render.
    fetch('/api/diagnostics')
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (s) setStats(s); })
      .catch(() => {});
    fetch('/api/sync-log?tail=50')
      .then(r => r.json())
      .then(l => {
        const lines: LogEntry[] = (l.lines || []).map((line: string) => {
          try { return JSON.parse(line) as LogEntry; } catch { return null; }
        }).filter(Boolean);
        setLog(lines.reverse()); // most recent first
      })
      .catch(() => {});
  }

  function loadClassifyCounts() {
    fetch('/api/ai/classify-all')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setClassifyCounts({ eligible: d.eligible ?? 0, pending: d.pending ?? 0 }); })
      .catch(() => {});
  }

  useEffect(() => {
    loadAll();
    loadClassifyCounts();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(loadAll, 2000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  async function clearLog() {
    await fetch('/api/sync-log', { method: 'DELETE' });
    loadAll();
  }

  function forceRefresh() {
    window.postMessage({ type: 'inboxpro-refresh-request' }, '*');
  }

  async function classifyAll(force = false) {
    if (classifyState === 'running') return;
    setClassifyState('running');
    setClassifyError(null);
    setClassifyProgress({ done: 0, total: 0, labels: 0, review: 0 });
    try {
      const r = await fetch('/api/ai/classify-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      const ids: string[] = d.ids ?? [];
      if (ids.length === 0) {
        setClassifyState('done');
        setClassifyProgress({ done: 0, total: 0, labels: 0, review: 0 });
        return;
      }
      setClassifyProgress({ done: 0, total: ids.length, labels: 0, review: 0 });
      const CHUNK = 25;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const cr = await fetch('/api/ai/classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationIds: slice, force }),
        });
        const cd = await cr.json();
        if (!cr.ok) throw new Error(cd.error ?? `HTTP ${cr.status}`);
        setClassifyProgress((p) => ({
          done: p.done + slice.length,
          total: ids.length,
          labels: p.labels + (cd.labelsApplied ?? 0),
          review: p.review + (cd.reviewFlagged ?? 0),
        }));
      }
      setClassifyState('done');
      // Refresh labels + conversations so freshly-applied labels render with names
      await loadFromServer();
      loadClassifyCounts();
    } catch (e) {
      setClassifyState('error');
      setClassifyError(e instanceof Error ? e.message : 'Classify failed');
    }
  }

  function startFullLiSync() {
    if (liSyncState === 'running') return;
    setLiSyncState('running');
    setLiSyncMsg('Starting…');

    function onMsg(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type === 'inboxpro-li-api-sync-progress') {
        const p = ev.data.progress || {};
        if (p.phase === 'inbox') setLiSyncMsg(`Pulling ${p.category || ''} · ${p.convs ?? 0} convs`);
        else if (p.phase === 'messages') setLiSyncMsg(`Fetching messages · ${p.fetched ?? 0} / ${p.total ?? 0} threads`);
      }
      if (ev.data.type === 'inboxpro-li-initial-sync-api-result') {
        window.removeEventListener('message', onMsg);
        const r = ev.data.response;
        if (r?.ok) {
          setLiSyncState('done');
          setLiSyncMsg(`Done · ${r.convs ?? 0} convs · ${r.msgs ?? 0} msgs`);
          loadAll();
        } else {
          setLiSyncState('error');
          setLiSyncMsg(r?.reason ?? 'Sync failed');
        }
      }
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ type: 'inboxpro-li-initial-sync-api', deepFetch: true }, '*');
  }

  return (
    <div className="card flex-1 overflow-y-auto p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-text-primary)]">Diagnostics</h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)] cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ accentColor: 'var(--color-accent)' }}
            />
            Auto-refresh
          </label>
          <button
            onClick={loadAll}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] rounded-lg"
          >
            <RefreshCw className="w-3 h-3" /> Reload
          </button>
        </div>
      </div>

      {/* Status row */}
      <section className="mb-6">
        <div className="grid grid-cols-3 gap-3">
          <div className={cn(
            'rounded-lg p-3 border',
            bridgeReady
              ? 'bg-[var(--color-success)]/10 border-[var(--color-success)]/30'
              : 'bg-[var(--color-danger)]/10 border-[var(--color-danger)]/30',
          )}>
            <div className="flex items-center gap-2">
              {bridgeReady
                ? <CheckCircle2 className="w-4 h-4 text-[var(--color-success)]" />
                : <AlertTriangle className="w-4 h-4 text-[var(--color-danger)]" />}
              <span className="eyebrow">Extension bridge</span>
            </div>
            <div className={cn('text-[15px] font-semibold mt-1', bridgeReady ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]')}>
              {bridgeReady ? 'Connected' : 'Not detected'}
            </div>
            {!bridgeReady && (
              <div className="text-[11px] text-[var(--color-danger)]/80 mt-1">
                Reload at chrome://extensions, then hard-refresh this page
              </div>
            )}
          </div>

          <div className="card p-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[var(--color-accent)]" />
              <span className="eyebrow">Profile</span>
            </div>
            <div className="text-sm font-semibold text-[var(--color-text-primary)] mt-1 truncate">
              {stats?.appState.profileName ?? '—'}
            </div>
            <div className="text-xs text-[var(--color-text-tertiary)] mt-0.5 truncate">
              {stats?.appState.myProfileUrn?.slice(-30) ?? '—'}
            </div>
          </div>

          <div className="card p-3">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-[var(--color-info)]" />
              <span className="eyebrow">Last sync</span>
            </div>
            <div className="text-sm font-semibold text-[var(--color-text-primary)] mt-1">
              {stats?.appState.lastSyncedAt
                ? new Date(stats.appState.lastSyncedAt).toLocaleString()
                : 'Never'}
            </div>
          </div>
        </div>
      </section>

      {/* Parser health — surfaces when LinkedIn shape drifts under our scrapers */}
      <ParserHealthSection />

      {/* DB stats */}
      <section className="mb-6">
        <h3 className="eyebrow mb-3">Database</h3>
        <div className="grid grid-cols-4 gap-3">
          <StatBox label="Conversations" value={stats?.convCount.toLocaleString() ?? '—'} color="gray" />
          <StatBox label="Messages" value={stats?.msgCount.toLocaleString() ?? '—'} color="gray" />
          <StatBox label="Unread" value={stats?.unread ?? '—'} color="gray" />
          <StatBox label="Starred" value={stats?.starred ?? '—'} color="gray" />
          <StatBox label="Archived" value={stats?.archived ?? '—'} color="gray" />
          <StatBox label="With notes" value={stats?.withNotes ?? '—'} color="gray" />
          <StatBox label="Follow-ups" value={stats?.withFollowUp ?? '—'} color="gray" />
          <StatBox
            label="Data quality"
            value={stats ? (stats.orphanedPreviews + stats.emptyParticipants) : '—'}
            color={
              stats && (stats.orphanedPreviews + stats.emptyParticipants) > 0 ? 'amber' : 'green'
            }
            sub={
              stats && stats.orphanedPreviews + stats.emptyParticipants > 0
                ? `${stats.orphanedPreviews} empty previews, ${stats.emptyParticipants} no participants`
                : 'all rows complete'
            }
          />
        </div>
      </section>

      {/* Quick actions */}
      <section className="mb-6">
        <h3 className="eyebrow mb-3">Quick actions</h3>
        {classifyState === 'running' && (
          <div className="mb-3 p-3 rounded-lg bg-[var(--color-accent-soft)] border border-[var(--color-accent)]/30 flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-[var(--color-accent)] animate-pulse flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-[var(--color-text-primary)]">
                Classifying {classifyProgress.done.toLocaleString()} / {classifyProgress.total.toLocaleString()}
                {classifyProgress.total > 0 && ` · ${Math.round((classifyProgress.done / classifyProgress.total) * 100)}%`}
              </div>
              <div className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">
                {classifyProgress.labels.toLocaleString()} labels applied · {classifyProgress.review.toLocaleString()} flagged for review
              </div>
              {classifyProgress.total > 0 && (
                <div className="mt-2 h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--color-accent)] transition-all"
                    style={{ width: `${(classifyProgress.done / classifyProgress.total) * 100}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
        {classifyState === 'done' && classifyProgress.total > 0 && (
          <div className="mb-3 p-2.5 rounded-lg bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 text-[12px] text-[var(--color-text-secondary)]">
            ✓ Classified {classifyProgress.done.toLocaleString()} conversations · {classifyProgress.labels.toLocaleString()} labels · {classifyProgress.review.toLocaleString()} for review
          </div>
        )}
        {classifyState === 'error' && (
          <div className="mb-3 p-2.5 rounded-lg bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 text-[12px] text-[var(--color-danger)]">
            ✗ {classifyError}
          </div>
        )}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={forceRefresh}
            disabled={!bridgeReady}
            className="flex items-center gap-2 px-3 py-2 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:bg-[var(--color-surface-2)] disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Force refresh now
          </button>
          <button
            onClick={clearLog}
            className="flex items-center gap-2 px-3 py-2 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-secondary)] text-sm rounded-lg"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear sync log
          </button>
          <button
            onClick={startFullLiSync}
            disabled={liSyncState === 'running' || !bridgeReady}
            className="flex items-center gap-2 px-3 py-2 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed text-sm rounded-lg"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', liSyncState === 'running' && 'animate-spin')} />
            {liSyncState === 'running' ? liSyncMsg : liSyncState === 'done' ? `✓ ${liSyncMsg}` : liSyncState === 'error' ? `✗ ${liSyncMsg}` : 'Full LinkedIn re-sync'}
          </button>
          <button
            onClick={() => classifyAll(false)}
            disabled={classifyState === 'running' || classifyCounts?.pending === 0}
            className="flex items-center gap-2 px-3 py-2 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed text-sm rounded-lg"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
            title="Run AI classification across unclassified conversations"
          >
            <Sparkles className={cn('w-3.5 h-3.5', classifyState === 'running' && 'animate-pulse')} />
            {classifyCounts === null
              ? 'AI-classify all conversations'
              : classifyCounts.pending === 0
              ? `All ${classifyCounts.eligible} classified`
              : `AI-classify ${classifyCounts.pending} conversations (~${formatDuration(classifyCounts.pending)})`}
          </button>
          {classifyCounts && classifyCounts.eligible > 0 && (
            <button
              onClick={() => {
                if (confirm(`Re-classify all ${classifyCounts.eligible} conversations? This overwrites existing AI labels and follow-ups. Estimated time: ~${formatDuration(classifyCounts.eligible)}.`)) {
                  classifyAll(true);
                }
              }}
              disabled={classifyState === 'running'}
              className="flex items-center gap-2 px-3 py-2 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed text-sm rounded-lg"
              style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
              title="Re-classify everything from scratch — overwrites existing AI labels and follow-ups"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Force re-classify all (~{formatDuration(classifyCounts.eligible)})
            </button>
          )}
          <ResetButton onDone={loadAll} />
        </div>
      </section>

      <section className="mb-6">
        <div className="rounded-lg bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 px-4 py-3 text-[11.5px] text-[var(--color-text-secondary)] leading-relaxed">
          <strong className="text-[var(--color-text-primary)]">Sync architecture:</strong> LinkedIn uses a fetch-response intercept + 10s bridge poll + 5min alarm. Sales Navigator uses inbox-list intercept + 10s bridge poll + 3min alarm, plus an action-trigger that fires <code className="mono bg-[var(--color-surface-2)] px-1 rounded">snRefreshNow</code> the moment you send from SN. Look for <code className="mono bg-[var(--color-surface-2)] px-1 rounded">alarm.fire</code>, <code className="mono bg-[var(--color-surface-2)] px-1 rounded">snBg.done</code>, and <code className="mono bg-[var(--color-surface-2)] px-1 rounded">sn.msgs.imported</code> in the log below to confirm activity.
        </div>
      </section>

      {/* Sync log */}
      <section>
        <h3 className="eyebrow mb-3">
          Recent sync events {log.length > 0 && <span className="text-[var(--color-text-tertiary)] normal-case font-normal tracking-normal">({log.length})</span>}
        </h3>
        <div className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-lg overflow-hidden">
          {log.length === 0 ? (
            <div className="p-6 text-center text-[13px] text-[var(--color-text-tertiary)]">
              No sync events yet. Activity will appear here as it happens.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto font-mono text-[11px]">
              {log.map((e, i) => {
                const time = e.t?.slice(11, 19) ?? '';
                const isError = e.ev?.includes('fail') || e.ev?.includes('err');
                const isPushed = e.ev === 'backgroundSync.pushed' || e.ev === 'refreshThread.ok';
                const rest = Object.entries(e)
                  .filter(([k]) => !['t', 'src', 'ev'].includes(k))
                  .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                  .join(' ');
                return (
                  <div
                    key={i}
                    className={cn(
                      'px-3 py-1.5 border-b border-[var(--color-hairline)] last:border-0 flex gap-3',
                      isError && 'bg-[var(--color-danger)]/10',
                      isPushed && 'bg-[var(--color-success)]/10',
                    )}
                  >
                    <span className="text-[var(--color-text-tertiary)] flex-shrink-0">{time}</span>
                    <span className={cn(
                      'flex-shrink-0 w-20 truncate',
                      e.src === 'bridge' ? 'text-[var(--color-accent)]' :
                      e.src === 'background' ? 'text-[var(--color-info)]' :
                      e.src === 'content' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-tertiary)]',
                    )}>{e.src}</span>
                    <span className={cn(
                      'flex-shrink-0 w-44 truncate',
                      isError ? 'text-[var(--color-danger)]' :
                      isPushed ? 'text-[var(--color-success)]' : 'text-[var(--color-text-secondary)]',
                    )}>{e.ev}</span>
                    <span className="text-[var(--color-text-tertiary)] truncate">{rest}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// Parser health widget — reads /api/parser-health, shows per-source success
// rate over the last 7 days. Surfaces drift in LinkedIn's response shape
// before it becomes painful (no recent captures, success rate cratering).
type ParserHealthSource = {
  source: string;
  total: number;
  success: number;
  failure: number;
  rate: number | null;
  lastSampleAt: string | null;
  samples24h: number;
};

const SOURCE_LABELS: Record<string, string> = {
  'sdui-parse': 'SDUI parser',
  'profile-capture-dom': 'Profile DOM scrape',
  'voyager-tap': 'Voyager API tap',
};

function ParserHealthSection() {
  const [data, setData] = useState<{ sources: ParserHealthSource[]; windowHours: number } | null>(null);
  useEffect(() => {
    fetch('/api/parser-health').then((r) => r.json()).then(setData).catch(() => {});
  }, []);
  return (
    <section className="mb-6">
      <h3 className="eyebrow mb-3">Parser health (last 7 days)</h3>
      <div className="grid grid-cols-3 gap-3">
        {(data?.sources ?? [
          { source: 'sdui-parse' }, { source: 'profile-capture-dom' }, { source: 'voyager-tap' },
        ] as ParserHealthSource[]).map((s) => {
          const rate = s.rate;
          const noData = s.total === 0;
          const color: 'gray' | 'green' | 'amber' | 'red' =
            noData ? 'gray'
            : rate === null ? 'gray'
            : rate >= 0.95 ? 'green'
            : rate >= 0.80 ? 'amber'
            : 'red';
          const pct = rate === null ? '—' : `${Math.round(rate * 100)}%`;
          const sub = noData
            ? 'no samples yet'
            : `${s.success}/${s.total} ok · ${s.samples24h} in 24h${s.lastSampleAt ? ` · last ${new Date(s.lastSampleAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}`;
          return (
            <StatBox
              key={s.source}
              label={SOURCE_LABELS[s.source] ?? s.source}
              value={pct}
              color={color}
              sub={sub}
            />
          );
        })}
      </div>
    </section>
  );
}

// Empirical: ~1.3s per conv on Haiku, batched in 25s with some network overhead.
// Round up so users aren't surprised by it running long.
function formatDuration(count: number): string {
  const seconds = Math.ceil(count * 1.5);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours} hr` : `${hours} hr ${remMin} min`;
}
