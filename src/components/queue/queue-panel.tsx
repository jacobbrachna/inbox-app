'use client';
import { useEffect, useState, useRef } from 'react';
import {
  Flame, AlertTriangle, Snowflake, Moon, ChevronRight, RefreshCw,
  Sparkles, MoreHorizontal, Star, BellOff, Clock,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';

interface QueueItem {
  id: string;
  name: string;
  headline: string;
  company: string | null;
  avatarUrl: string | null;
  lastMessageAt: string;
  reason: string;
  daysSince: number;
  aiScore: number | null;
  aiSignal: string | null;
  icpFit: number | null;
  isIcp: boolean;
  manualIcp: boolean;
  snoozedUntil: string | null;
}

interface QueueData {
  topPriority: QueueItem[];
  hot: QueueItem[];
  overdue: QueueItem[];
  goingCold: QueueItem[];
  stale: QueueItem[];
  counts: { topPriority: number; hot: number; overdue: number; goingCold: number; stale: number; total: number };
  unscored: string[];
}

const BUCKETS = [
  {
    key: 'hot' as const,
    label: 'Hot — your turn',
    desc: 'They replied. You haven\'t responded yet.',
    icon: Flame,
    color: 'var(--color-danger)',
  },
  {
    key: 'overdue' as const,
    label: 'Overdue follow-ups',
    desc: 'You scheduled a follow-up that\'s now past due.',
    icon: AlertTriangle,
    color: 'var(--color-accent)',
  },
  {
    key: 'goingCold' as const,
    label: 'Going cold',
    desc: 'You sent the last message 3+ days ago, no reply.',
    icon: Snowflake,
    color: 'var(--color-info)',
  },
  {
    key: 'stale' as const,
    label: 'Stale relationships',
    desc: 'Warm lead or client with no activity in 30+ days.',
    icon: Moon,
    color: 'var(--color-text-tertiary)',
  },
];

// Snooze presets — match the values to the menu labels exactly.
const SNOOZE_PRESETS: { label: string; days: number }[] = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
];

// PATCH the conversation row directly — same endpoint conv-context-menu uses
// for snooze/star/archive elsewhere in the app. Returns true on success.
async function patchConversation(id: string, patch: Record<string, unknown>) {
  try {
    const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function RowMenu({ item, onMutate }: { item: QueueItem; onMutate: () => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  async function dismiss() {
    setOpen(false);
    await patchConversation(item.id, { queueDismissed: true });
    onMutate();
  }
  async function toggleIcp() {
    setOpen(false);
    await patchConversation(item.id, { manualIcp: !item.manualIcp });
    onMutate();
  }
  async function snooze(days: number) {
    setOpen(false);
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    await patchConversation(item.id, { snoozedUntil: until });
    onMutate();
  }

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)]"
        style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        title="More actions"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="menu-in absolute right-0 mt-1 z-50 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl w-56 py-1 overflow-hidden"
            style={{ boxShadow: 'var(--shadow-raised)' }}
          >
            <button
              onClick={toggleIcp}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-card-hover)]"
            >
              <Star className={cn('w-3.5 h-3.5', item.manualIcp && 'fill-[var(--color-accent)] text-[var(--color-accent)]')} />
              {item.manualIcp ? 'Remove ICP flag' : 'Mark as ICP'}
            </button>
            <button
              onClick={dismiss}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-card-hover)]"
            >
              <BellOff className="w-3.5 h-3.5" />
              Not a priority
            </button>
            <div className="border-t border-[var(--color-hairline)] my-1" />
            <div className="px-3 pt-1.5 pb-1 text-[10.5px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> Remind me in
            </div>
            {SNOOZE_PRESETS.map((s) => (
              <button
                key={s.days}
                onClick={() => snooze(s.days)}
                className="w-full text-left px-3 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-card-hover)]"
              >
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Single-row renderer used by every bucket + top priority. Click anywhere on
// the row to open the conversation; the menu trigger stops propagation.
function QueueRow({
  item,
  accentColor,
  reasonText,
  reasonColor,
  showScore,
  isLast,
  onClick,
  onMutate,
}: {
  item: QueueItem;
  accentColor: string;
  reasonText: string;
  reasonColor: string;
  showScore?: boolean;
  isLast: boolean;
  onClick: () => void;
  onMutate: () => void;
}) {
  // ICP chip color: bright accent when strong fit (manualIcp or icpFit ≥ 80),
  // muted gold for "close fit" (60-79), nothing below.
  const strongIcp = item.manualIcp || (item.icpFit !== null && item.icpFit >= 80);
  const closeIcp = !strongIcp && item.icpFit !== null && item.icpFit >= 60;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-card-hover)] cursor-pointer',
        !isLast && 'border-b border-[var(--color-hairline)]',
      )}
      style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
    >
      <div className="w-9 h-9 rounded-[10px] overflow-hidden bg-[var(--color-surface-2)] flex items-center justify-center flex-shrink-0">
        {item.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.avatarUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
            {item.name.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '·'}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-[var(--color-text-primary)] truncate">{item.name}</span>
          {item.company && (
            <span className="text-[11px] text-[var(--color-text-tertiary)] truncate">· {item.company}</span>
          )}
          {strongIcp && (
            <span
              className="mono text-[9.5px] tabular-nums px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-semibold flex-shrink-0 flex items-center gap-0.5"
              title={item.manualIcp ? 'Manually flagged as ICP' : `Strong ICP fit · ${item.icpFit}%`}
            >
              <Star className="w-2.5 h-2.5 fill-current" />
              ICP
            </span>
          )}
          {closeIcp && (
            <span
              className="mono text-[9.5px] tabular-nums px-1.5 py-0.5 rounded border border-[var(--color-hairline)] text-[var(--color-text-tertiary)] flex-shrink-0"
              title={`Close ICP fit · ${item.icpFit}%`}
            >
              {item.icpFit}%
            </span>
          )}
          {item.snoozedUntil && new Date(item.snoozedUntil).getTime() > Date.now() && (
            <span className="text-[10px] text-[var(--color-text-tertiary)] flex-shrink-0">
              · snoozed
            </span>
          )}
        </div>
        {item.headline && (
          <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">{item.headline}</div>
        )}
      </div>
      <div className="text-right flex-shrink-0 flex items-center gap-2">
        {showScore && item.aiScore !== null && (
          <span className="mono text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-semibold">
            {item.aiScore}
          </span>
        )}
        <div className="text-[11px] font-medium" style={{ color: reasonColor }}>{reasonText}</div>
        <RowMenu item={item} onMutate={onMutate} />
        <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] flex-shrink-0" />
      </div>
    </div>
  );
}

export function QueuePanel() {
  const [data, setData] = useState<QueueData | null>(null);
  const [loading, setLoading] = useState(false);
  const [onlyIcp, setOnlyIcp] = useState(false);
  // Background-scoring state. We fire one batch on mount (or after a reload)
  // when the queue has unscored items, then re-fetch so the new badges appear.
  // The ref prevents overlapping batches if the user clicks reload mid-run.
  const [scoring, setScoring] = useState<{ done: number; total: number } | null>(null);
  const scoringInFlight = useRef(false);
  const setActiveConversationId = useStore((s) => s.setActiveConversationId);
  // The "current role era" toggle is a GLOBAL filter — apply it to the queue
  // too (server-side, so the buckets + counts stay accurate).
  const currentRoleOnly = useStore((s) => s.currentRoleOnly);
  const currentRoleStart = useStore((s) => s.currentRoleStart);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (onlyIcp) params.set('onlyIcp', '1');
    if (currentRoleOnly && currentRoleStart) params.set('roleStart', currentRoleStart);
    const qs = params.toString();
    return fetch(`/api/queue${qs ? `?${qs}` : ''}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); return d as QueueData; })
      .catch(() => { setLoading(false); return null; });
  }

  // Auto-score any unscored queue items in the background. Chunks of 25 per
  // /api/queue/score-batch call (the endpoint caps at 50 internally) and
  // reloads the queue once the whole run finishes so the badges appear.
  async function autoScore(ids: string[]) {
    if (scoringInFlight.current || ids.length === 0) return;
    scoringInFlight.current = true;
    setScoring({ done: 0, total: ids.length });
    try {
      const CHUNK = 25;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const r = await fetch('/api/queue/score-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ convIds: slice }),
        });
        if (!r.ok) break; // hard stop on error (e.g. no API key)
        setScoring((p) => p ? { ...p, done: p.done + slice.length } : null);
      }
      await load();
    } finally {
      scoringInFlight.current = false;
      // Short delay before hiding the indicator so the "done" state is visible.
      setTimeout(() => setScoring(null), 1500);
    }
  }

  useEffect(() => {
    load().then((d) => {
      if (d && Array.isArray(d.unscored) && d.unscored.length > 0) {
        autoScore(d.unscored);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyIcp, currentRoleOnly, currentRoleStart]);

  function open(id: string) {
    // Stay in the queue view — the thread opens in the panel beside the list
    // (see page.tsx queue branch). No more navigating away to the inbox.
    setActiveConversationId(id);
  }

  return (
    <div className="card flex-1 overflow-y-auto p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">Outbound queue</h2>
        <div className="flex items-center gap-1">
          {/* "Only ICP" toggle — strict focus mode. When off, non-fits are
              still shown but sorted to the bottom of each bucket. */}
          <button
            onClick={() => setOnlyIcp((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[11.5px] font-medium',
              onlyIcp
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]',
            )}
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
            title={onlyIcp ? 'Showing only ICP fits — click to show all' : 'Show only ICP fits'}
          >
            <Star className={cn('w-3 h-3', onlyIcp && 'fill-current')} />
            Only ICP
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
            style={{ transition: 'all 180ms var(--ease-out-quart)' }}
            title="Reload"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>
      <p className="text-[12px] text-[var(--color-text-tertiary)] mb-6">
        Your daily worklist. {data ? `${data.counts.total} threads need attention.` : 'Loading…'}
        {scoring && (
          <span className="ml-2 text-[var(--color-accent)]">
            · scoring {scoring.done}/{scoring.total}…
          </span>
        )}
      </p>

      {data && data.counts.total === 0 && (
        <div className="card p-8 text-center">
          <p className="text-[14px] text-[var(--color-text-secondary)]">Inbox zero on the queue. 🎯</p>
          <p className="text-[11.5px] text-[var(--color-text-tertiary)] mt-1">
            No hot threads, no overdue follow-ups, no going-cold leads, no stale relationships.
          </p>
        </div>
      )}

      {/* Top Priority — AI-curated cross-bucket picks (score ≥ 70) */}
      {data && data.topPriority && data.topPriority.length > 0 && (
        <section className="mb-7">
          <div className="flex items-baseline gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-[var(--color-accent)]" />
            <h3 className="text-[14px] font-semibold text-[var(--color-text-primary)]">Top priority today</h3>
            <span className="mono text-[11px] text-[var(--color-text-tertiary)]">{data.topPriority.length}</span>
          </div>
          <p className="text-[11px] text-[var(--color-text-tertiary)] mb-2">
            AI-detected high-intent threads across all buckets. Work these first.
          </p>
          <div className="card overflow-hidden">
            {data.topPriority.map((it, i) => (
              <QueueRow
                key={it.id}
                item={it}
                accentColor="var(--color-accent)"
                reasonText={it.aiSignal || it.reason}
                reasonColor="var(--color-accent)"
                showScore
                isLast={i === data.topPriority.length - 1}
                onClick={() => open(it.id)}
                onMutate={load}
              />
            ))}
          </div>
        </section>
      )}

      {BUCKETS.map((b) => {
        const items = data?.[b.key] ?? [];
        if (items.length === 0) return null;
        const Icon = b.icon;
        return (
          <section key={b.key} className="mb-7">
            <div className="flex items-baseline gap-2 mb-2">
              <Icon className="w-4 h-4" style={{ color: b.color }} />
              <h3 className="text-[14px] font-semibold text-[var(--color-text-primary)]">{b.label}</h3>
              <span className="mono text-[11px] text-[var(--color-text-tertiary)]">{items.length}</span>
            </div>
            <p className="text-[11px] text-[var(--color-text-tertiary)] mb-2">{b.desc}</p>
            <div className="card overflow-hidden">
              {items.map((it, i) => (
                <QueueRow
                  key={it.id}
                  item={it}
                  accentColor={b.color}
                  reasonText={it.reason}
                  reasonColor={b.color}
                  isLast={i === items.length - 1}
                  onClick={() => open(it.id)}
                  onMutate={load}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
