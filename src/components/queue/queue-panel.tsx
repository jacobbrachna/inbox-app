'use client';
import { useEffect, useState } from 'react';
import { Flame, AlertTriangle, Snowflake, Moon, ChevronRight, RefreshCw, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';

interface QueueItem {
  id: string;
  name: string;
  headline: string;
  company: string | null;
  avatarUrl: string | null;
  aiCategory: string | null;
  lastMessageAt: string;
  reason: string;
  daysSince: number;
  aiScore: number | null;
  aiSignal: string | null;
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

export function QueuePanel() {
  const [data, setData] = useState<QueueData | null>(null);
  const [loading, setLoading] = useState(false);
  const [scoring, setScoring] = useState<{ active: boolean; done: number; total: number } | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const setActiveConversationId = useStore((s) => s.setActiveConversationId);
  const setActiveFilter = useStore((s) => s.setActiveFilter);

  function load() {
    setLoading(true);
    return fetch('/api/queue')
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); return d as QueueData; })
      .catch(() => { setLoading(false); return null; });
  }

  // Score any unscored convs surfaced by the queue endpoint, then refresh once done.
  async function scoreUnscored(d: QueueData) {
    if (!d.unscored || d.unscored.length === 0) return;
    setScoreError(null);
    setScoring({ active: true, done: 0, total: d.unscored.length });
    try {
      const r = await fetch('/api/queue/score-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ convIds: d.unscored }),
      });
      const result = await r.json();
      if (!r.ok) {
        setScoreError(result.error === 'no_api_key'
          ? 'Add your Anthropic API key in Settings to enable AI scoring.'
          : (result.error ?? 'AI scoring failed'));
      } else {
        setScoring({ active: false, done: result.scored ?? 0, total: d.unscored.length });
        await load();
        return;
      }
    } catch (e) {
      setScoreError(e instanceof Error ? e.message : 'AI scoring failed');
    }
    setScoring(null);
  }

  useEffect(() => {
    (async () => {
      const d = await load();
      if (d) await scoreUnscored(d);
    })();
  }, []);

  function open(id: string) {
    setActiveFilter('all');
    setActiveConversationId(id);
  }

  return (
    <div className="card flex-1 overflow-y-auto p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">Outbound queue</h2>
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
      <p className="text-[12px] text-[var(--color-text-tertiary)] mb-6">
        Your daily worklist. {data ? `${data.counts.total} threads need attention.` : 'Loading…'}
      </p>

      {data && data.counts.total === 0 && (
        <div className="card p-8 text-center">
          <p className="text-[14px] text-[var(--color-text-secondary)]">Inbox zero on the queue. 🎯</p>
          <p className="text-[11.5px] text-[var(--color-text-tertiary)] mt-1">
            No hot threads, no overdue follow-ups, no going-cold leads, no stale relationships.
          </p>
        </div>
      )}

      {/* AI scoring status banner — visible while batch scoring runs OR if missing key */}
      {(scoring?.active || scoreError) && (
        <div
          className={cn(
            'card p-3 mb-6 flex items-center gap-2.5 text-[12px]',
            scoreError ? 'border-[var(--color-danger)]/40' : '',
          )}
        >
          {scoring?.active ? (
            <>
              <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)] animate-pulse" />
              <span className="text-[var(--color-text-secondary)]">
                AI scoring {scoring.total} conversations… this happens once and gets cached.
              </span>
            </>
          ) : scoreError ? (
            <>
              <Sparkles className="w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
              <span className="text-[var(--color-text-tertiary)]">{scoreError}</span>
            </>
          ) : null}
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
              <button
                key={it.id}
                onClick={() => open(it.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-card-hover)] text-left',
                  i < data.topPriority.length - 1 && 'border-b border-[var(--color-hairline)]',
                )}
                style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
              >
                <div className="w-9 h-9 rounded-[10px] overflow-hidden bg-[var(--color-surface-2)] flex items-center justify-center flex-shrink-0">
                  {it.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.avatarUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                      {it.name.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '·'}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium text-[var(--color-text-primary)] truncate">{it.name}</span>
                    {it.company && (
                      <span className="text-[11px] text-[var(--color-text-tertiary)] truncate">· {it.company}</span>
                    )}
                  </div>
                  {it.headline && (
                    <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">{it.headline}</div>
                  )}
                </div>
                <div className="text-right flex-shrink-0 flex items-center gap-2">
                  <span className="mono text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-semibold">
                    {it.aiScore}
                  </span>
                  <div>
                    <div className="text-[11px] font-medium text-[var(--color-accent)]">{it.aiSignal || it.reason}</div>
                  </div>
                </div>
              </button>
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
                <button
                  key={it.id}
                  onClick={() => open(it.id)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-card-hover)] text-left',
                    i < items.length - 1 && 'border-b border-[var(--color-hairline)]',
                  )}
                  style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
                >
                  <div className="w-9 h-9 rounded-[10px] overflow-hidden bg-[var(--color-surface-2)] flex items-center justify-center flex-shrink-0">
                    {it.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.avatarUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                        {it.name.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '·'}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[13px] font-medium text-[var(--color-text-primary)] truncate">{it.name}</span>
                      {it.company && (
                        <span className="text-[11px] text-[var(--color-text-tertiary)] truncate">· {it.company}</span>
                      )}
                    </div>
                    {it.headline && (
                      <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">{it.headline}</div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-[11px] font-medium" style={{ color: b.color }}>{it.reason}</div>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-tertiary)] flex-shrink-0" />
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
