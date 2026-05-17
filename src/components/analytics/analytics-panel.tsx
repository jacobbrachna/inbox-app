'use client';
import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, MessageSquare, Clock, Star, Inbox, Send, Download, ChevronDown } from 'lucide-react';
import { useStore } from '@/store';

interface AnalyticsData {
  range: { from: string | null; to: string | null };
  totalConversations: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  conversationsInRange: number;
  totalMessages: number;
  sent: number;
  received: number;
  responseRate: number;
  coldOutbound: number;
  coldReplied: number;
  avgReplyHours: number;
  dailyVolume: Array<{ date: string; sent: number; received: number }>;
  labelCounts: Record<string, number>;
  lastSyncedAt: string | null;
}

// ─── Time period helpers ───────────────────────────────────────────────────────
type PeriodKey = '7d' | '30d' | '90d' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'all' | 'custom';

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay();
  // Treat Monday as start of week (ISO style); adjust if you prefer Sunday
  const diff = (day === 0 ? -6 : 1 - day);
  out.setDate(out.getDate() + diff);
  out.setHours(0, 0, 0, 0);
  return out;
}

function getRange(key: PeriodKey, customFrom?: string, customTo?: string): { from: string | null; to: string | null; label: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (key) {
    case '7d': {
      const from = new Date(today);
      from.setDate(from.getDate() - 6);
      return { from: isoDay(from), to: isoDay(today), label: 'Last 7 days' };
    }
    case '30d': {
      const from = new Date(today);
      from.setDate(from.getDate() - 29);
      return { from: isoDay(from), to: isoDay(today), label: 'Last 30 days' };
    }
    case '90d': {
      const from = new Date(today);
      from.setDate(from.getDate() - 89);
      return { from: isoDay(from), to: isoDay(today), label: 'Last 90 days' };
    }
    case 'this-week': {
      const from = startOfWeek(today);
      return { from: isoDay(from), to: isoDay(today), label: 'This week' };
    }
    case 'last-week': {
      const thisStart = startOfWeek(today);
      const from = new Date(thisStart);
      from.setDate(from.getDate() - 7);
      const to = new Date(thisStart);
      to.setDate(to.getDate() - 1);
      return { from: isoDay(from), to: isoDay(to), label: 'Last week' };
    }
    case 'this-month': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: isoDay(from), to: isoDay(today), label: 'This month' };
    }
    case 'last-month': {
      const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const to = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: isoDay(from), to: isoDay(to), label: 'Last month' };
    }
    case 'custom':
      return { from: customFrom ?? null, to: customTo ?? null, label: 'Custom range' };
    case 'all':
    default:
      return { from: null, to: null, label: 'All time' };
  }
}

// ─── UI bits ───────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color = 'blue' }: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: 'blue' | 'green' | 'orange' | 'purple';
}) {
  const colorClasses = {
    blue: 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]',
    green: 'text-[var(--color-success)] bg-[var(--color-success)]/10',
    orange: 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]',
    purple: 'text-[var(--color-info)] bg-[var(--color-info)]/10',
  };
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <span className="eyebrow">{label}</span>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colorClasses[color]}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className="text-2xl font-bold text-[var(--color-text-primary)]">{value}</div>
      {sub && <div className="text-xs text-[var(--color-text-tertiary)] mt-1">{sub}</div>}
    </div>
  );
}

const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'this-week', label: 'This week' },
  { key: 'last-week', label: 'Last week' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom…' },
];

function PeriodDropdown({ value, onChange }: { value: PeriodKey; onChange: (k: PeriodKey) => void }) {
  const [open, setOpen] = useState(false);
  const current = PERIOD_OPTIONS.find((p) => p.key === value)?.label ?? 'All time';
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-primary)] text-sm font-medium rounded-lg transition-colors"
      >
        {current}
        <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="menu-in absolute right-0 mt-1 z-50 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl w-44 py-1 overflow-hidden"
            style={{ boxShadow: 'var(--shadow-raised)' }}
          >
            {PERIOD_OPTIONS.map((p) => (
              <button
                key={p.key}
                onClick={() => { onChange(p.key); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-card-hover)] ${value === p.key ? 'text-[var(--color-accent)] font-medium' : 'text-[var(--color-text-secondary)]'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────────

export function AnalyticsPanel() {
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const { labels } = useStore();

  const range = useMemo(() => getRange(period, customFrom, customTo), [period, customFrom, customTo]);

  useEffect(() => {
    if (period === 'custom' && (!customFrom || !customTo)) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    const qs = params.toString();
    fetch(`/api/analytics${qs ? '?' + qs : ''}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); });
  }, [range.from, range.to, period, customFrom, customTo]);

  if (!data && !loading) {
    return <div className="card flex-1 overflow-y-auto p-6"><p className="text-[var(--color-text-tertiary)] text-[13px]">Loading analytics…</p></div>;
  }

  const maxDay = data ? Math.max(...data.dailyVolume.map((d) => d.sent + d.received), 1) : 1;

  return (
    <div className="card flex-1 overflow-y-auto p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-text-primary)]">Analytics</h2>
        <div className="flex items-center gap-2">
          <PeriodDropdown value={period} onChange={setPeriod} />
          <a
            href="/api/export?format=csv"
            className="flex items-center gap-2 px-3 py-2 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-secondary)] text-sm font-medium rounded-lg transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </a>
        </div>
      </div>
      <p className="text-xs text-[var(--color-text-tertiary)] mb-6">
        {range.label}
        {range.from && range.to && range.label !== range.from && (
          <span className="ml-1">· {range.from} → {range.to}</span>
        )}
      </p>

      {/* Custom range picker */}
      {period === 'custom' && (
        <div className="card p-4 mb-4 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
            From
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded px-2 py-1 text-[12px] text-[var(--color-text-primary)]"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
            To
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded px-2 py-1 text-[12px] text-[var(--color-text-primary)]"
            />
          </label>
        </div>
      )}

      {!data ? (
        <p className="text-[var(--color-text-tertiary)] text-sm">Loading…</p>
      ) : (
        <>
          {/* Top stats */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <StatCard
              icon={Inbox}
              label="Active conversations"
              value={data.conversationsInRange.toLocaleString()}
              sub={`${data.totalConversations.toLocaleString()} total in inbox`}
              color="blue"
            />
            <StatCard
              icon={MessageSquare}
              label="Messages"
              value={data.totalMessages.toLocaleString()}
              sub={`${data.sent} sent · ${data.received} received`}
              color="purple"
            />
            <StatCard
              icon={TrendingUp}
              label="Response rate"
              value={`${Math.round(data.responseRate * 100)}%`}
              sub={`${data.coldReplied} replies on ${data.coldOutbound} cold outreach`}
              color="green"
            />
            <StatCard
              icon={Clock}
              label="Avg reply time"
              value={data.avgReplyHours > 0 ? `${data.avgReplyHours.toFixed(1)}h` : '—'}
              sub="Their message → my reply"
              color="orange"
            />
          </div>

          <div className="grid grid-cols-3 gap-4 mb-6">
            <StatCard icon={Inbox} label="Unread (total)" value={data.unreadCount} color="blue" />
            <StatCard icon={Star} label="Starred (total)" value={data.starredCount} color="orange" />
            <StatCard
              icon={Send}
              label="Sent (period)"
              value={data.sent.toLocaleString()}
              sub={`${data.received.toLocaleString()} received`}
              color="green"
            />
          </div>

          {/* Daily volume bar chart */}
          <section className="card p-5 mb-6">
            <h3 className="text-sm font-bold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">
              Daily volume — {range.label}
            </h3>
            {data.dailyVolume.length === 0 ? (
              <p className="text-[var(--color-text-tertiary)] text-sm">No activity in this period</p>
            ) : (
              <>
                <div className="flex items-end gap-1.5 h-40">
                  {data.dailyVolume.map((d) => (
                    <div
                      key={d.date}
                      className="flex-1 flex flex-col-reverse items-stretch gap-px min-w-[2px]"
                      title={`${d.date}: ${d.sent} sent, ${d.received} received`}
                    >
                      <div
                        className="bg-[var(--color-success)] hover:opacity-80 rounded-sm transition-colors"
                        style={{ height: `${(d.received / maxDay) * 100}%` }}
                      />
                      <div
                        className="bg-[var(--color-accent)] hover:opacity-80 rounded-sm transition-colors"
                        style={{ height: `${(d.sent / maxDay) * 100}%` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-xs text-[var(--color-text-tertiary)] mt-2">
                  <span>{data.dailyVolume[0]?.date.slice(5)}</span>
                  <span>{data.dailyVolume[data.dailyVolume.length - 1]?.date.slice(5)}</span>
                </div>
                <div className="flex gap-4 text-xs text-[var(--color-text-tertiary)] mt-2">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 bg-[var(--color-accent)] rounded-sm" /> Sent</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 bg-[var(--color-success)] rounded-sm" /> Received</span>
                </div>
              </>
            )}
          </section>

          {/* Label distribution */}
          {Object.keys(data.labelCounts).length > 0 && (
            <section className="card p-5">
              <h3 className="text-sm font-bold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-4">
                Label distribution — {range.label}
              </h3>
              <div className="space-y-2">
                {Object.entries(data.labelCounts).map(([id, count]) => {
                  const label = labels.find((l) => l.id === id);
                  return (
                    <div key={id} className="flex items-center gap-3 text-sm">
                      <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: label?.color ?? '#6b7280' }}
                      />
                      <span className="text-[var(--color-text-secondary)] flex-1">{label?.name ?? id}</span>
                      <span className="text-[var(--color-text-tertiary)] font-medium">{count}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <ActivitySection from={range.from ?? ''} to={range.to ?? ''} />
        </>
      )}
    </div>
  );
}

interface ActivityData {
  window: { from: string; to: string; days: number; replyWindowDays: number };
  totals: { outbound: number; inbound: number; replied: number; replyRate: number; avgResponseTimeHours: number };
  byLabel: Array<{ labelId: string; name: string; color: string | null; sent: number; replies: number; replyRate: number }>;
  queues: { hot: unknown[]; goingCold: unknown[]; awaitingFirstReply: number };
}

function ActivitySection({ from, to }: { from: string; to: string }) {
  const [act, setAct] = useState<ActivityData | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    fetch(`/api/analytics/activity${qs.toString() ? `?${qs}` : ''}`)
      .then((r) => r.json())
      .then(setAct)
      .catch(() => {});
  }, [from, to]);

  if (!act) return null;

  return (
    <section className="card p-5 mt-6">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="eyebrow">What&rsquo;s working — last {act.window.days}d</h3>
        <span className="text-[10.5px] mono text-[var(--color-text-tertiary)]">{act.window.replyWindowDays}d reply window</span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-lg p-3">
          <div className="eyebrow">Reply rate</div>
          <div className="text-[22px] font-semibold mt-1 tracking-tight text-[var(--color-text-primary)]">
            {(act.totals.replyRate * 100).toFixed(0)}%
          </div>
          <div className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">
            {act.totals.replied} / {act.totals.outbound} outbound
          </div>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-lg p-3">
          <div className="eyebrow">Avg response time</div>
          <div className="text-[22px] font-semibold mt-1 tracking-tight text-[var(--color-text-primary)]">
            {act.totals.avgResponseTimeHours > 0 ? `${act.totals.avgResponseTimeHours.toFixed(1)}h` : '—'}
          </div>
          <div className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">When they reply</div>
        </div>
        <div className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-lg p-3">
          <div className="eyebrow">Awaiting first reply</div>
          <div className="text-[22px] font-semibold mt-1 tracking-tight text-[var(--color-text-primary)]">
            {act.queues.awaitingFirstReply}
          </div>
          <div className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">Outbound, never heard back</div>
        </div>
      </div>

      {act.byLabel.length > 0 && (
        <>
          <div className="eyebrow mb-2">Reply rate by label</div>
          <div className="space-y-1.5">
            {act.byLabel.map((row) => (
              <div key={row.labelId} className="flex items-center gap-3 text-[12.5px]">
                <span className="w-32 text-[var(--color-text-secondary)] truncate flex items-center gap-1.5">
                  {row.color && (
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: row.color }} />
                  )}
                  {row.name}
                </span>
                <div className="flex-1 h-2 bg-[var(--color-surface)] rounded-full overflow-hidden">
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.max(2, row.replyRate * 100)}%`,
                      background: row.color ?? 'var(--color-accent)',
                      transition: 'width 240ms var(--ease-out-quart)',
                    }}
                  />
                </div>
                <span className="mono text-[10.5px] text-[var(--color-text-tertiary)] w-20 text-right">
                  {(row.replyRate * 100).toFixed(0)}% · {row.sent}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
