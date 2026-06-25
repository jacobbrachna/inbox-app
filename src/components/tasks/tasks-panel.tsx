'use client';
import { useEffect, useState, useMemo } from 'react';
import { CheckSquare, UserPlus, UserMinus, BellRing, ExternalLink, RefreshCw, Sparkles, ChevronRight, Briefcase, ArrowRight, MessageSquare, Archive, Check, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';

interface NewConnectionItem {
  contactId: string;
  name: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  headline: string | null;
  company: string | null;
  role: string | null;
  source: string | null;
  firstSeenAt: string;
  connectedOn: string | null;
  linkedinUrn: string | null;
  profileSlug: string | null;
}
interface FollowUpThread {
  conversationId: string;
  followUpAt: string;
  followUpReason: string | null;
  followUpSource: string | null;
  followUpConfidence: string | null;
  daysUntilDue: number;
}
interface FollowUpContact {
  contactId: string | null;
  name: string;
  avatarUrl: string | null;
  headline: string | null;
  company: string | null;
  nextFollowUpAt: string;
  nextDaysUntilDue: number;
  followUps: FollowUpThread[];
}
interface JobChangeItem {
  contactId: string;
  name: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  changedAt: string;
  previousCompany: string | null;
  newCompany: string | null;
  previousRole: string | null;
  newRole: string | null;
  changeKind: 'company' | 'role' | 'both';
}
interface TasksData {
  newConnections: NewConnectionItem[];
  newConnectionsTotal: number;
  followUpsOwed: FollowUpContact[];
  counts: { newConnections: number; followUpsOwed: number };
}

type Tab = 'new' | 'followups' | 'jobs';

function relativeDate(s: string): string {
  const d = new Date(s).getTime();
  if (!d) return '—';
  const days = Math.floor((Date.now() - d) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function dueLabel(daysUntilDue: number): { text: string; tone: 'overdue' | 'today' | 'soon' } {
  if (daysUntilDue < 0) return { text: `${Math.abs(daysUntilDue)}d overdue`, tone: 'overdue' };
  if (daysUntilDue === 0) return { text: 'Due today', tone: 'today' };
  return { text: `Due in ${daysUntilDue}d`, tone: 'soon' };
}

export function TasksPanel() {
  const [data, setData] = useState<TasksData | null>(null);
  const [jobChanges, setJobChanges] = useState<JobChangeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('new');
  // New Connections controls: hide coworkers (default) + recency window.
  const [showCoworkers, setShowCoworkers] = useState(false);
  const [within, setWithin] = useState<'30' | '90' | 'all'>('90');
  const setActiveConversationId = useStore((s) => s.setActiveConversationId);
  const setActiveFilter = useStore((s) => s.setActiveFilter);
  const updateConversation = useStore((s) => s.updateConversation);
  const loadFromServer = useStore((s) => s.loadFromServer);
  const currentRoleOnly = useStore((s) => s.currentRoleOnly);
  const currentRoleStart = useStore((s) => s.currentRoleStart);

  function load(silent = false) {
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    if (currentRoleOnly && currentRoleStart) params.set('roleStart', currentRoleStart);
    if (showCoworkers) params.set('coworkers', '1');
    if (within !== '90') params.set('within', within);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return Promise.all([
      fetch(`/api/tasks${qs}`).then((r) => r.json()),
      fetch('/api/tasks/job-changes').then((r) => r.json()).catch(() => ({ changes: [] })),
    ])
      .then(([t, j]: [TasksData, { changes: JobChangeItem[] }]) => {
        setData(t);
        setJobChanges(Array.isArray(j?.changes) ? j.changes : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [currentRoleOnly, currentRoleStart, showCoworkers, within]);

  function openConversation(id: string) {
    setActiveFilter('all');
    setActiveConversationId(id);
  }

  // Message a brand-new connection: there's no thread yet, so spin up a draft
  // conversation pre-filled with this contact as the recipient (+ LinkedIn as
  // the channel) and drop the user straight into the composer. Mirrors the
  // sidebar's "New message" flow, minus the empty recipient picker. The send
  // path needs the LinkedIn URN — if we don't have one the composer still opens
  // and prompts the user to capture it by visiting the profile once.
  async function messageConnection(c: NewConnectionItem) {
    try {
      const r = await fetch('/api/conversations/draft', { method: 'POST' });
      if (!r.ok) return;
      const d = await r.json();
      const draftId = d.conversation.id;
      await loadFromServer();
      updateConversation(draftId, {
        participants: [{
          id: c.linkedinUrn ?? '',
          name: c.name,
          headline: c.headline ?? undefined,
          avatarUrl: c.avatarUrl ?? undefined,
          profileUrl: c.profileUrl ?? undefined,
          company: c.company ?? undefined,
        }],
        source: 'linkedin',
      });
      setActiveFilter('drafts');
      setActiveConversationId(draftId);
    } catch {}
  }

  // Dismiss a connection off the New Connections list. The list removes the
  // row optimistically; we persist the soft-hide flag, then silently refetch
  // so the tab count stays accurate.
  function dismissConnection(contactId: string) {
    fetch('/api/tasks/dismiss-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId }),
    }).catch(() => {});
    setTimeout(() => load(true), 500);
  }

  // Archive a conversation straight from the task list. The list removes the
  // row optimistically; we persist via the store (which also mirrors the
  // archive to LinkedIn/SN) and then silently refetch so the tab counts and
  // any sibling threads stay accurate.
  function archiveFromTasks(conversationId: string) {
    updateConversation(conversationId, { status: 'archived' });
    setTimeout(() => load(true), 500);
  }

  const tabs: Array<{ key: Tab; label: string; icon: typeof UserPlus; count: number; tone: string }> = useMemo(() => [
    { key: 'new', label: 'New Connections', icon: UserPlus, count: data?.counts.newConnections ?? 0, tone: 'var(--color-accent-deep)' },
    { key: 'followups', label: 'Follow-ups Owed', icon: BellRing, count: data?.counts.followUpsOwed ?? 0, tone: 'var(--color-warning, #d89568)' },
    { key: 'jobs', label: 'Job Changes', icon: Briefcase, count: jobChanges.length, tone: 'var(--color-success, #5C7045)' },
  ], [data, jobChanges]);

  return (
    <div className="card flex-1 overflow-y-auto p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-[var(--color-accent-soft)] flex items-center justify-center flex-shrink-0">
            <CheckSquare className="w-4 h-4 text-[var(--color-accent-deep)]" strokeWidth={2.25} />
          </div>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)] truncate">Tasks</h1>
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          style={{ transition: 'all 180ms var(--ease-out-quart)' }}
          title="Reload"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <p className="text-[12px] text-[var(--color-text-tertiary)] mb-5">Your daily action list across connections, leads, and follow-ups.</p>

      {/* Tab strip */}
      <div className="flex gap-1 mb-5 border-b border-[var(--color-hairline)]">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 text-[12.5px] font-medium border-b-2 -mb-px',
                active
                  ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]'
                  : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]',
              )}
              style={{ transition: 'color 140ms var(--ease-out-quart)' }}
            >
              <Icon className="w-3.5 h-3.5" style={{ color: active ? t.tone : undefined }} />
              <span>{t.label}</span>
              <span className={cn(
                'mono text-[10px] tabular-nums px-1.5 py-0.5 rounded',
                active ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]' : 'text-[var(--color-text-tertiary)]',
              )}>
                {t.count > 999 ? '999+' : t.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {loading && !data && (
        <div className="flex flex-col gap-2 py-4" aria-label="Loading tasks">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 64 }} />
          ))}
        </div>
      )}

      {data && tab === 'new' && (
        <>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="inline-flex rounded-lg border border-[var(--color-hairline)] overflow-hidden">
              {(['30', '90', 'all'] as const).map((w) => (
                <button
                  key={w}
                  onClick={() => setWithin(w)}
                  className={cn(
                    'text-[11px] px-2.5 py-1 transition-colors',
                    within === w
                      ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-medium'
                      : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]',
                  )}
                >
                  {w === 'all' ? 'All' : `Last ${w}d`}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowCoworkers((v) => !v)}
              className={cn(
                'text-[11px] px-2.5 py-1 rounded-lg border transition-colors',
                showCoworkers
                  ? 'border-[var(--color-accent)] text-[var(--color-accent-fg)] bg-[var(--color-accent-soft)]'
                  : 'border-[var(--color-hairline)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {showCoworkers ? 'Showing coworkers' : 'Hiding coworkers'}
            </button>
            <span className="text-[10.5px] text-[var(--color-text-tertiary)] ml-auto">
              Dates &amp; companies fill in via the extension&rsquo;s &ldquo;Sync connections&rdquo;.
            </span>
          </div>
          <NewConnectionsList items={data.newConnections} total={data.newConnectionsTotal} onMessage={messageConnection} onDismiss={dismissConnection} />
        </>
      )}
      {data && tab === 'followups' && (
        <FollowUpsList items={data.followUpsOwed} onOpen={openConversation} onArchive={archiveFromTasks} />
      )}
      {data && tab === 'jobs' && (
        <JobChangesList items={jobChanges} />
      )}
    </div>
  );
}

// ── New Connections ──────────────────────────────────────────────────────
function NewConnectionsList({ items, total, onMessage, onDismiss }: {
  items: NewConnectionItem[];
  total: number;
  onMessage: (c: NewConnectionItem) => void;
  onDismiss: (contactId: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());

  function dismiss(contactId: string) {
    setDismissedIds((prev) => { const next = new Set(prev); next.add(contactId); return next; });
    setConfirmId(null);
    onDismiss(contactId);
  }

  // Optimistic removal — a dismissed row vanishes instantly; the server
  // refetch then trims the count to match.
  const visibleItems = items.filter((c) => !dismissedIds.has(c.contactId));
  // Keep the headline count honest after optimistic removals this session.
  const visibleTotal = Math.max(0, total - dismissedIds.size);

  if (visibleItems.length === 0) {
    return (
      <EmptyState
        icon={UserPlus}
        title="No new connections."
        body="Once you connect with people on LinkedIn — or upload your Connections.csv export — they'll appear here until you've sent them their first message."
      />
    );
  }
  return (
    <div>
      <p className="text-[11px] text-[var(--color-text-tertiary)] mb-3">
        {visibleTotal} connection{visibleTotal === 1 ? '' : 's'} you haven&apos;t messaged yet. Showing the {visibleItems.length} most recent.
      </p>
      <div className="card overflow-hidden">
        {visibleItems.map((c, i) => (
          <div
            key={c.contactId}
            className={cn(
              'w-full flex items-center gap-3 px-4 py-3',
              i < visibleItems.length - 1 && 'border-b border-[var(--color-hairline)]',
            )}
          >
            <AvatarSquare name={c.name} src={c.avatarUrl} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-[var(--color-text-primary)] truncate">{c.name}</span>
                {c.company && (
                  <span className="text-[11px] text-[var(--color-text-tertiary)] truncate">· {c.company}</span>
                )}
              </div>
              <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">
                {c.role || c.headline || '—'}
              </div>
            </div>
            <div className="text-right flex-shrink-0 flex items-center gap-2">
              {confirmId === c.contactId ? (
                <div className="flex items-center gap-1">
                  <span className="text-[10.5px] text-[var(--color-text-tertiary)] mr-0.5">Remove?</span>
                  <button
                    onClick={() => dismiss(c.contactId)}
                    title="Confirm remove"
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
                    style={{ transition: 'all 140ms var(--ease-out-quart)' }}
                  >
                    <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    title="Cancel"
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
                    style={{ transition: 'all 140ms var(--ease-out-quart)' }}
                  >
                    <X className="w-3.5 h-3.5" strokeWidth={2.5} />
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-[10.5px] text-[var(--color-text-tertiary)]">
                    {c.connectedOn
                      ? `Connected ${relativeDate(c.connectedOn)}`
                      : `Added ${relativeDate(c.firstSeenAt)}`}
                  </span>
                  <button
                    onClick={() => onMessage(c)}
                    title="Message — opens a new draft to this person"
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
                    style={{ transition: 'all 140ms var(--ease-out-quart)' }}
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                  </button>
                  {c.profileUrl && (
                    <a
                      href={c.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
                      title="Open LinkedIn profile"
                      style={{ transition: 'all 140ms var(--ease-out-quart)' }}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                  <button
                    onClick={() => setConfirmId(c.contactId)}
                    title="Remove from this list"
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-surface-2)]"
                    style={{ transition: 'all 140ms var(--ease-out-quart)' }}
                  >
                    <UserMinus className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Hot Leads ────────────────────────────────────────────────────────────
// ── Follow-ups Owed (per-contact) ────────────────────────────────────────
// Per-row actions on a task: message the person (open the thread) or archive
// them off the list. Archive is two-step — the first click arms an inline
// "Archive?" confirm so a misclick can't silently remove someone.
function RowActions({
  confirming, onMessage, onRequestConfirm, onCancelConfirm, onArchive,
}: {
  confirming: boolean;
  onMessage: () => void;
  onRequestConfirm: () => void;
  onCancelConfirm: () => void;
  onArchive: () => void;
}) {
  if (confirming) {
    return (
      <div className="flex items-center gap-1 flex-shrink-0">
        <span className="text-[10.5px] text-[var(--color-text-tertiary)] mr-0.5">Archive?</span>
        <button
          onClick={(e) => { e.stopPropagation(); onArchive(); }}
          title="Confirm archive"
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onCancelConfirm(); }}
          title="Cancel"
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          <X className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); onMessage(); }}
        title="Open thread / send a message"
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
        style={{ transition: 'all 140ms var(--ease-out-quart)' }}
      >
        <MessageSquare className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onRequestConfirm(); }}
        title="Archive — remove from tasks"
        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-surface-2)]"
        style={{ transition: 'all 140ms var(--ease-out-quart)' }}
      >
        <Archive className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function FollowUpsList({ items, onOpen, onArchive }: {
  items: FollowUpContact[];
  onOpen: (id: string) => void;
  onArchive: (conversationId: string) => void;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => new Set());

  function archive(conversationId: string) {
    setArchivedIds((prev) => { const next = new Set(prev); next.add(conversationId); return next; });
    setConfirmId(null);
    onArchive(conversationId);
  }

  // Optimistic removal — an archived thread vanishes from the list instantly,
  // and a person with no remaining follow-ups drops off entirely.
  const visibleItems = items
    .map((p) => ({ ...p, followUps: p.followUps.filter((f) => !archivedIds.has(f.conversationId)) }))
    .filter((p) => p.followUps.length > 0);

  if (visibleItems.length === 0) {
    return (
      <EmptyState
        icon={BellRing}
        title="No follow-ups owed."
        body="Set a follow-up date on any conversation, or let the AI detect timing language in incoming messages. Anyone you've committed to follow up with will appear here."
      />
    );
  }
  return (
    <div className="card overflow-hidden">
      {visibleItems.map((person, i) => {
        const key = person.contactId ?? person.followUps[0]?.conversationId ?? `idx:${i}`;
        const isExpanded = expandedKey === key;
        const soonest = person.followUps.reduce((a, b) =>
          new Date(a.followUpAt).getTime() < new Date(b.followUpAt).getTime() ? a : b
        );
        const due = dueLabel(soonest.daysUntilDue);
        const toneClass =
          due.tone === 'overdue' ? 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
          : due.tone === 'today' ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]'
          : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]';
        const aiBadge = soonest.followUpSource === 'ai';
        const moreCount = person.followUps.length - 1;
        return (
          <div
            key={key}
            className={cn(i < visibleItems.length - 1 && 'border-b border-[var(--color-hairline)]')}
          >
            <div
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-card-hover)]"
              style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
            >
              <button
                onClick={() => {
                  if (moreCount > 0) setExpandedKey(isExpanded ? null : key);
                  else onOpen(soonest.conversationId);
                }}
                className="flex items-center gap-3 min-w-0 flex-1 text-left"
              >
                <AvatarSquare name={person.name} src={person.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium text-[var(--color-text-primary)] truncate">
                      {person.name}
                    </span>
                    {person.company && (
                      <span className="text-[11px] text-[var(--color-text-tertiary)] truncate">· {person.company}</span>
                    )}
                    {aiBadge && (
                      <span className="inline-flex items-center gap-1 text-[9.5px] uppercase tracking-wide font-semibold text-[var(--color-accent)]">
                        <Sparkles className="w-2.5 h-2.5" /> AI
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">
                    {soonest.followUpReason ? `"${soonest.followUpReason}"` : (person.headline || '—')}
                  </div>
                </div>
              </button>
              <div className="flex-shrink-0 flex items-center gap-2">
                <span className={cn('mono text-[10px] tabular-nums px-1.5 py-0.5 rounded font-semibold', toneClass)}>
                  {due.text}
                </span>
                {moreCount > 0 && (
                  <button
                    onClick={() => setExpandedKey(isExpanded ? null : key)}
                    className="flex items-center gap-1"
                    title={`${moreCount} more follow-up${moreCount === 1 ? '' : 's'} on other threads`}
                  >
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] font-medium">
                      +{moreCount}
                    </span>
                    <ChevronRight
                      className={cn(
                        'w-3.5 h-3.5 text-[var(--color-text-tertiary)] transition-transform',
                        isExpanded && 'rotate-90',
                      )}
                    />
                  </button>
                )}
                <RowActions
                  confirming={confirmId === soonest.conversationId}
                  onMessage={() => onOpen(soonest.conversationId)}
                  onRequestConfirm={() => setConfirmId(soonest.conversationId)}
                  onCancelConfirm={() => setConfirmId(null)}
                  onArchive={() => archive(soonest.conversationId)}
                />
              </div>
            </div>
            {isExpanded && moreCount > 0 && (
              <div className="bg-[var(--color-surface)] border-t border-[var(--color-hairline)]">
                {person.followUps
                  .slice()
                  .sort((a, b) => a.daysUntilDue - b.daysUntilDue)
                  .map((thr) => {
                    const td = dueLabel(thr.daysUntilDue);
                    const ttone =
                      td.tone === 'overdue' ? 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
                      : td.tone === 'today' ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]'
                      : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]';
                    return (
                      <div
                        key={thr.conversationId}
                        className="w-full flex items-center gap-3 pl-16 pr-4 py-2 hover:bg-[var(--color-card-hover)] text-[11.5px]"
                        style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
                      >
                        <button
                          onClick={() => onOpen(thr.conversationId)}
                          className="flex-1 text-left text-[var(--color-text-secondary)] truncate"
                        >
                          {thr.followUpReason ? `"${thr.followUpReason}"` : 'No reason'}
                        </button>
                        <span className={cn('mono text-[10px] tabular-nums px-1.5 py-0.5 rounded font-semibold', ttone)}>
                          {td.text}
                        </span>
                        <RowActions
                          confirming={confirmId === thr.conversationId}
                          onMessage={() => onOpen(thr.conversationId)}
                          onRequestConfirm={() => setConfirmId(thr.conversationId)}
                          onCancelConfirm={() => setConfirmId(null)}
                          onArchive={() => archive(thr.conversationId)}
                        />
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Job Changes ──────────────────────────────────────────────────────────
function JobChangesList({ items }: { items: JobChangeItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title="No recent job changes."
        body="When a contact's company or role updates (via profile-capture, harvest, or CSV re-import), they'll appear here. We compare against the previous snapshot, so changes only surface for people we've enriched at least twice."
      />
    );
  }
  return (
    <div className="card overflow-hidden">
      {items.map((c, i) => (
        <div
          key={c.contactId}
          className={cn(
            'flex items-center gap-3 px-4 py-3',
            i < items.length - 1 && 'border-b border-[var(--color-hairline)]',
          )}
        >
          <AvatarSquare name={c.name} src={c.avatarUrl} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium text-[var(--color-text-primary)] truncate">{c.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
                {c.changeKind === 'both' ? 'New role + company' : c.changeKind === 'company' ? 'New company' : 'New role'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-tertiary)] truncate mt-0.5">
              {c.changeKind !== 'role' && (
                <>
                  <span className="line-through opacity-70">{c.previousCompany || '—'}</span>
                  <ArrowRight className="w-3 h-3 flex-shrink-0" />
                  <span className="text-[var(--color-text-secondary)] font-medium">{c.newCompany || '—'}</span>
                </>
              )}
              {c.changeKind === 'role' && (
                <>
                  <span className="line-through opacity-70">{c.previousRole || '—'}</span>
                  <ArrowRight className="w-3 h-3 flex-shrink-0" />
                  <span className="text-[var(--color-text-secondary)] font-medium">{c.newRole || '—'}</span>
                </>
              )}
            </div>
          </div>
          <div className="text-right flex-shrink-0 flex items-center gap-2">
            <span className="text-[10.5px] text-[var(--color-text-tertiary)]">
              {relativeDate(c.changedAt)}
            </span>
            {c.profileUrl && (
              <a
                href={c.profileUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
                title="Open LinkedIn profile"
                style={{ transition: 'all 140ms var(--ease-out-quart)' }}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────
function AvatarSquare({ name, src }: { name: string; src: string | null }) {
  return (
    <div className="w-9 h-9 rounded-[10px] overflow-hidden bg-[var(--color-surface-2)] flex items-center justify-center flex-shrink-0">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="w-full h-full object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
          {name.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '·'}
        </span>
      )}
    </div>
  );
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof UserPlus; title: string; body: React.ReactNode }) {
  return (
    <div className="card p-8 text-center">
      <Icon className="w-6 h-6 text-[var(--color-text-tertiary)] mx-auto mb-3" />
      <p className="text-[14px] font-medium text-[var(--color-text-secondary)] mb-1">{title}</p>
      <p className="text-[11.5px] text-[var(--color-text-tertiary)] max-w-md mx-auto">{body}</p>
    </div>
  );
}
