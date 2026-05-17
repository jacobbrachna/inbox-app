'use client';
import { useState, useEffect } from 'react';
import {
  Inbox, Mail, Star, Clock, Archive, Settings,
  ChevronDown, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight,
  Plus, MessageSquare, TrendingUp, BarChart3, Activity, BellRing, Flame, Users, CheckSquare, HelpCircle, PanelLeftOpen, PanelLeftClose, Layout, Pencil,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { storage, type SidebarMode } from '@/lib/storage';
import { useStore } from '@/store';
import type { FilterView, Label } from '@/types';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { LabelCreateModal } from '@/components/labels/label-create-modal';

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
}

// Sidebar parent has `group/sidebar` class. Below lg breakpoint, label spans
// are hidden by default but revealed via `group-hover/sidebar:inline`. Above lg
// they stay visible always (max-lg: prefix is a no-op).
function NavItem({ icon, label, count, active, onClick }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        'relative w-full flex items-center gap-3 px-3 py-2 rounded-[10px] text-[13px] overflow-hidden',
        // Collapsed: center the only visible child (icon). Hover/expanded:
        // back to left-aligned for label + count layout.
        'max-lg:justify-center max-lg:group-hover/sidebar:justify-start',
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-medium'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]',
      )}
      style={{ transition: 'background-color var(--dur-fast) var(--ease-out-soft), color var(--dur-fast) var(--ease-out-soft)' }}
    >
      {/* Left accent rail — slides in from the left edge when active.
          Subtle but reads as "selected" without a heavy bg change. */}
      <span
        aria-hidden
        className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-[var(--color-accent)]"
        style={{
          transform: active ? 'translateX(0)' : 'translateX(-6px)',
          opacity: active ? 1 : 0,
          transition: 'transform var(--dur-medium) var(--ease-spring-gentle), opacity var(--dur-fast) var(--ease-out-soft)',
        }}
      />
      <span
        className={cn(
          'flex-shrink-0 relative',
          active ? 'text-[var(--color-accent-deep)]' : 'text-[var(--color-text-tertiary)]',
        )}
      >
        {icon}
        {/* Mini count badge over icon, only shown when sidebar is collapsed (< lg, not hovered) */}
        {count !== undefined && count > 0 && (
          <span className="hidden max-lg:flex max-lg:group-hover/sidebar:hidden absolute -top-1.5 -right-2 mono text-[9px] font-medium px-1 min-w-[14px] h-[14px] items-center justify-center rounded-full bg-[var(--color-accent)] text-white tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
      <span className="flex-1 text-left truncate max-lg:hidden max-lg:group-hover/sidebar:inline">
        {label}
      </span>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            'mono text-[10px] tabular-nums max-lg:hidden max-lg:group-hover/sidebar:inline',
            active ? 'text-[var(--color-accent-deep)] font-medium' : 'text-[var(--color-text-tertiary)]',
          )}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

// Label row: NavItem-style filter button + hover-revealed pencil for edit.
// The pencil is a sibling button (not nested) so the markup stays valid.
function LabelRow({ label, count, active, onSelect, onEdit }: {
  label: Label;
  count?: number;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="group/label relative">
      <NavItem
        icon={<span className="w-2 h-2 rounded-full" style={{ backgroundColor: label.color }} />}
        label={label.name}
        count={count}
        active={active}
        onClick={onSelect}
      />
      {/* Edit pencil — appears on row hover, hidden in fully-collapsed sidebar */}
      <button
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)] opacity-0 group-hover/label:opacity-100 max-lg:hidden max-lg:group-hover/sidebar:inline-flex"
        style={{ transition: 'opacity 140ms var(--ease-out-quart), color 140ms var(--ease-out-quart)' }}
        title="Edit label"
        aria-label={`Edit ${label.name}`}
      >
        <Pencil className="w-3 h-3" />
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-5 pb-2 max-lg:hidden max-lg:group-hover/sidebar:block">
      <span className="eyebrow">{children}</span>
    </div>
  );
}

export function Sidebar() {
  const { auth, activeFilter, setActiveFilter, labels, addLabel, removeLabel, conversations, lastSyncedAt } = useStore();
  const [labelsOpen, setLabelsOpen] = useState(true);
  const [aiLabelsOpen, setAiLabelsOpen] = useState(false);
  const [labelModalOpen, setLabelModalOpen] = useState(false);
  const [editingLabel, setEditingLabel] = useState<Label | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('auto');
  const loadFromServer = useStore((s) => s.loadFromServer);
  const setActiveConversationId = useStore((s) => s.setActiveConversationId);
  const currentRoleOnly = useStore((s) => s.currentRoleOnly);
  const setCurrentRoleOnly = useStore((s) => s.setCurrentRoleOnly);
  const currentRoleStart = useStore((s) => s.currentRoleStart);
  const currentRoleLabel = useStore((s) => s.currentRoleLabel);
  const setCurrentRoleMeta = useStore((s) => s.setCurrentRoleMeta);

  // Hydrate current-role meta from /api/patterns once. That endpoint
  // already derives windowStart/windowEntry from myEmploymentHistory —
  // reusing it avoids duplicating the date-parsing here.
  useEffect(() => {
    if (currentRoleStart) return;
    fetch('/api/patterns')
      .then((r) => r.json())
      .then((d) => {
        if (d?.windowStart) setCurrentRoleMeta(d.windowStart, d.windowEntry?.company ?? null);
      })
      .catch(() => {});
  }, [currentRoleStart, setCurrentRoleMeta]);

  // Click "New message" → server creates an empty draft Conversation row,
  // we navigate the user into it via the Drafts filter. The thread view
  // detects status='draft' and renders the inline recipient picker + channel
  // picker + compose so all the usual thread chrome (AI Drafts, snippets,
  // etc.) works the same as on a real conversation.
  async function startNewDraft() {
    try {
      const r = await fetch('/api/conversations/draft', { method: 'POST' });
      if (!r.ok) return;
      const d = await r.json();
      await loadFromServer();
      setActiveFilter('drafts');
      setActiveConversationId(d.conversation.id);
    } catch {}
  }

  // Restore mode from localStorage on mount
  useEffect(() => {
    const v = storage.sidebarMode.get();
    if (v) setSidebarMode(v);
  }, []);

  function cycleSidebarMode() {
    // At wide viewport (lg+), auto and expanded look identical, so cycling
    // through both produces no visible change on the first click. Skip the
    // redundant state — from auto go directly to the opposite of what the
    // current viewport renders.
    const isWide = typeof window !== 'undefined' && window.innerWidth >= 1024;
    let next: SidebarMode;
    if (sidebarMode === 'auto') {
      next = isWide ? 'collapsed' : 'expanded';
    } else if (sidebarMode === 'expanded') {
      next = 'collapsed';
    } else {
      next = 'auto';
    }
    setSidebarMode(next);
    storage.sidebarMode.set(next);
  }

  // Counts: drafts excluded from all non-drafts views so the totals match
  // what the user actually sees in each filter.
  const unreadCount = conversations.filter((c) => c.status === 'unread').length;
  const starredCount = conversations.filter((c) => c.isStarred && c.status !== 'draft').length;
  const snoozedCount = conversations.filter((c) => c.status === 'snoozed').length;
  const draftsCount = conversations.filter((c) => c.status === 'draft').length;
  const now = Date.now();
  const overdueFollowUpCount = conversations.filter(
    (c) => !!c.followUpAt && new Date(c.followUpAt).getTime() < now,
  ).length;
  const reviewCount = conversations.filter((c) => c.needsReview === true).length;

  const labelCounts = labels.reduce(
    (acc, l) => ({ ...acc, [l.id]: conversations.filter((c) => c.labels.includes(l.id)).length }),
    {} as Record<string, number>,
  );

  function openCreateLabel() {
    setEditingLabel(null);
    setLabelModalOpen(true);
  }
  function openEditLabel(label: Label) {
    setEditingLabel(label);
    setLabelModalOpen(true);
  }

  return (
    <aside
      className={cn(
        'group/sidebar sidebar-root flex-shrink-0 relative',
        // Outer slot reserves 220px at lg+, 64px below. Inner is absolutely
        // positioned so it can overlay other columns when hovered.
        'w-[220px] max-lg:w-[64px]',
        sidebarMode === 'expanded' && 'sidebar-pin-expanded',
        sidebarMode === 'collapsed' && 'sidebar-pin-collapsed',
      )}
      // Sliding width animation drives the surrounding columns to reflow
      // smoothly when the sidebar mode changes.
      style={{ transition: 'width 180ms var(--ease-out-quart)' }}
    >
      <div
        className={cn(
          'card absolute inset-y-0 left-0 flex flex-col overflow-hidden z-30',
          'w-[220px] max-lg:w-[64px] max-lg:group-hover/sidebar:w-[220px]',
          // Elevate shadow when expanded as overlay so it reads as floating
          'max-lg:group-hover/sidebar:shadow-[var(--shadow-raised)]',
        )}
        style={{ transition: 'width 180ms var(--ease-out-quart), box-shadow 180ms var(--ease-out-quart)' }}
      >
      {/* Wordmark */}
      <div className="px-4 pt-5 pb-3 flex items-center gap-2.5 max-lg:justify-center max-lg:group-hover/sidebar:justify-start max-lg:px-0 max-lg:group-hover/sidebar:px-4">
        <div className="w-9 h-9 rounded-[10px] bg-[var(--color-accent-soft)] flex items-center justify-center flex-shrink-0">
          <span className="text-[15px] font-bold text-[var(--color-accent-fg)]">i</span>
        </div>
        <div className="leading-tight flex-1 min-w-0 max-lg:hidden max-lg:group-hover/sidebar:block">
          <div className="text-[15px] font-semibold tracking-tight text-[var(--color-text-primary)] truncate">
            InboxPro
          </div>
          <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">
            LinkedIn · Sales Nav
          </div>
        </div>
        {/* Notification bell — visible in expanded state. Badge shows unread count. */}
        <div className="max-lg:hidden max-lg:group-hover/sidebar:block">
          <NotificationBell />
        </div>
        {/* Sidebar mode cycle — auto / pinned expanded / pinned collapsed.
            Hidden in pure-collapsed state; visible whenever the sidebar is
            expanded (real or hover-expanded) so the user can always see it. */}
        <button
          onClick={cycleSidebarMode}
          className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)] flex-shrink-0 max-lg:hidden max-lg:group-hover/sidebar:inline-flex"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          title={
            sidebarMode === 'auto' ? 'Sidebar: Auto (resizes with window) — click to pin expanded'
            : sidebarMode === 'expanded' ? 'Sidebar: Pinned expanded — click to pin collapsed'
            : 'Sidebar: Pinned collapsed — click to reset to Auto'
          }
          aria-label="Toggle sidebar mode"
        >
          {sidebarMode === 'expanded' ? <PanelLeftClose className="w-4 h-4" />
            : sidebarMode === 'collapsed' ? <PanelLeftOpen className="w-4 h-4" />
            : <Layout className="w-4 h-4" />}
        </button>
      </div>

      <div className="h-px bg-[var(--color-hairline)] mx-4" />

      {/* New message — creates a draft conversation + drops user in the
          thread view to compose. Draft persists if they navigate away. */}
      <div className="px-3 pt-3 pb-1 max-lg:hidden max-lg:group-hover/sidebar:block">
        <button
          onClick={startNewDraft}
          className="press-feedback w-full flex items-center justify-center gap-2 px-3 py-2 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white text-[12.5px] font-semibold rounded-md"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          <Plus className="w-3.5 h-3.5" />
          New message
        </button>
      </div>

      {/* Current-role-only view toggle. Only renders when we know the
          user's role start date (their LinkedIn URL is set + employment
          history captured). Hides threads whose activity predates their
          current role — trims pre-job-change baggage without deleting it. */}
      {currentRoleStart && (
        <div className="px-3 pt-2 pb-1 max-lg:hidden max-lg:group-hover/sidebar:block">
          <button
            onClick={() => setCurrentRoleOnly(!currentRoleOnly)}
            className={cn(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-[11.5px]',
              currentRoleOnly
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-semibold'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)]',
            )}
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
            title={currentRoleOnly
              ? `Showing only threads since ${currentRoleLabel ?? 'current role'} started`
              : 'Hide threads from previous-employer eras'}
          >
            <span className="truncate">
              {currentRoleLabel ? `Only my ${currentRoleLabel} era` : 'Only current role'}
            </span>
            {/* Explicit pixel sizes for the pill — Tailwind classes weren't
                producing the expected geometry; locking dimensions inline.
                Pill 26×14, knob 10×10, inset 2px → travel 12px exactly.
                Smaller than my prior 32×16 to stop the label from clipping. */}
            <span
              className={cn(
                'flex-shrink-0 inline-block relative rounded-full overflow-hidden align-middle',
                currentRoleOnly ? 'bg-[var(--color-accent-deep)]' : 'bg-[var(--color-surface-2)]',
              )}
              style={{
                width: 26, height: 14,
                transition: 'background-color var(--dur-medium) var(--ease-out-soft)',
              }}>
              <span
                className="absolute bg-white rounded-full"
                style={{
                  width: 10, height: 10, top: 2, left: 2,
                  transform: currentRoleOnly ? 'translateX(12px)' : 'translateX(0)',
                  transition: 'transform var(--dur-medium) var(--ease-out-fluid)',
                }}
              />
            </span>
          </button>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 pt-1 pb-2">
        <SectionLabel>Inbox</SectionLabel>
        <NavItem
          icon={<Inbox className="w-4 h-4" />}
          label="All Messages"
          count={unreadCount}
          active={activeFilter === 'all'}
          onClick={() => setActiveFilter('all')}
        />
        <NavItem
          icon={<Mail className="w-4 h-4" />}
          label="Unread"
          count={unreadCount}
          active={activeFilter === 'unread'}
          onClick={() => setActiveFilter('unread')}
        />
        <NavItem
          icon={<Star className="w-4 h-4" />}
          label="Starred"
          count={starredCount}
          active={activeFilter === 'starred'}
          onClick={() => setActiveFilter('starred')}
        />
        <NavItem
          icon={<Clock className="w-4 h-4" />}
          label="Snoozed"
          count={snoozedCount}
          active={activeFilter === 'snoozed'}
          onClick={() => setActiveFilter('snoozed')}
        />
        <NavItem
          icon={<Pencil className="w-4 h-4" />}
          label="Drafts"
          count={draftsCount}
          active={activeFilter === 'drafts'}
          onClick={() => setActiveFilter('drafts')}
        />
        <NavItem
          icon={<BellRing className="w-4 h-4" />}
          label="Follow Up"
          count={overdueFollowUpCount}
          active={activeFilter === 'follow-up'}
          onClick={() => setActiveFilter('follow-up')}
        />
        <NavItem
          icon={<Archive className="w-4 h-4" />}
          label="Archived"
          active={activeFilter === 'archived'}
          onClick={() => setActiveFilter('archived')}
        />

        <SectionLabel>Source</SectionLabel>
        <NavItem
          icon={<MessageSquare className="w-4 h-4" />}
          label="LinkedIn DMs"
          active={activeFilter === 'linkedin'}
          onClick={() => setActiveFilter('linkedin')}
        />
        <NavItem
          icon={<TrendingUp className="w-4 h-4" />}
          label="Sales Navigator"
          active={activeFilter === 'sales_nav'}
          onClick={() => setActiveFilter('sales_nav')}
        />

        {/* AI Labels — auto-applied by the classifier */}
        <div className="px-3 pt-5 pb-1 max-lg:hidden max-lg:group-hover/sidebar:block">
          <div className="flex items-center">
            <button
              className="flex items-center gap-1 flex-1 eyebrow hover:text-[var(--color-text-secondary)]"
              onClick={() => setAiLabelsOpen(!aiLabelsOpen)}
              style={{ transition: 'color 150ms var(--ease-out-quart)' }}
            >
              {aiLabelsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              AI Labels
            </button>
          </div>
        </div>
        {aiLabelsOpen && (
          <div className="max-lg:hidden max-lg:group-hover/sidebar:block">
            {labels.filter((l) => l.aiManaged).map((label) => (
              <LabelRow
                key={label.id}
                label={label}
                count={labelCounts[label.id]}
                active={activeFilter === `label:${label.id}`}
                onSelect={() => setActiveFilter(`label:${label.id}` as FilterView)}
                onEdit={() => openEditLabel(label)}
              />
            ))}
            {labels.filter((l) => l.aiManaged).length === 0 && (
              <p className="px-3 py-1 text-[11px] text-[var(--color-text-tertiary)]">No AI labels yet.</p>
            )}
          </div>
        )}

        {/* My Labels — manual / user-created without AI descriptions */}
        <div className="px-3 pt-5 pb-1 max-lg:hidden max-lg:group-hover/sidebar:block">
          <div className="flex items-center">
            <button
              className="flex items-center gap-1 flex-1 eyebrow hover:text-[var(--color-text-secondary)]"
              onClick={() => setLabelsOpen(!labelsOpen)}
              style={{ transition: 'color 150ms var(--ease-out-quart)' }}
            >
              {labelsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              My Labels
            </button>
            <button
              onClick={openCreateLabel}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-accent-deep)]"
              style={{ transition: 'color 150ms var(--ease-out-quart)' }}
              title="New label"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>
        {labelsOpen && (
          <div className="max-lg:hidden max-lg:group-hover/sidebar:block">
            {labels.filter((l) => !l.aiManaged).map((label) => (
              <LabelRow
                key={label.id}
                label={label}
                count={labelCounts[label.id]}
                active={activeFilter === `label:${label.id}`}
                onSelect={() => setActiveFilter(`label:${label.id}` as FilterView)}
                onEdit={() => openEditLabel(label)}
              />
            ))}
            {labels.filter((l) => !l.aiManaged).length === 0 && (
              <p className="px-3 py-1 text-[11px] text-[var(--color-text-tertiary)]">
                Click <Plus className="w-3 h-3 inline" /> to add a manual label.
              </p>
            )}
          </div>
        )}

      </nav>

      <div className="h-px bg-[var(--color-hairline)] mx-4" />

      <div className="px-2 py-2">
        <NavItem
          icon={<CheckSquare className="w-4 h-4" />}
          label="Tasks"
          active={activeFilter === 'tasks'}
          onClick={() => setActiveFilter('tasks')}
        />
        <NavItem
          icon={<HelpCircle className="w-4 h-4" />}
          label="Review"
          count={reviewCount}
          active={activeFilter === 'review'}
          onClick={() => setActiveFilter('review')}
        />
        <NavItem
          icon={<Flame className="w-4 h-4" />}
          label="Outbound Queue"
          active={activeFilter === 'queue'}
          onClick={() => setActiveFilter('queue')}
        />
        <NavItem
          icon={<Users className="w-4 h-4" />}
          label="Contacts"
          active={activeFilter === 'contacts'}
          onClick={() => setActiveFilter('contacts')}
        />
        <NavItem
          icon={<BarChart3 className="w-4 h-4" />}
          label="Analytics"
          active={activeFilter === 'analytics'}
          onClick={() => setActiveFilter('analytics')}
        />
        <NavItem
          icon={<Activity className="w-4 h-4" />}
          label="Diagnostics"
          active={activeFilter === 'diagnostics'}
          onClick={() => setActiveFilter('diagnostics')}
        />
        <NavItem
          icon={<Settings className="w-4 h-4" />}
          label="Settings"
          active={activeFilter === 'settings'}
          onClick={() => setActiveFilter('settings')}
        />
      </div>

      {/* Footer: profile + theme toggle. Stack vertically when collapsed so
          both fit within 64px width, side-by-side when expanded. */}
      <div className="border-t border-[var(--color-hairline)] px-3 py-3 flex items-center gap-2.5 max-lg:flex-col max-lg:group-hover/sidebar:flex-row">
        {auth.isAuthenticated ? (
          <>
            <div
              className="w-8 h-8 rounded-[8px] bg-[var(--color-surface-2)] flex items-center justify-center text-[11px] font-medium text-[var(--color-text-secondary)] flex-shrink-0 overflow-hidden"
            >
              {auth.profileAvatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={auth.profileAvatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                (auth.profileName?.[0] ?? 'M').toUpperCase()
              )}
            </div>
            <div className="min-w-0 flex-1 max-lg:hidden max-lg:group-hover/sidebar:block">
              <div className="text-[12px] font-medium text-[var(--color-text-primary)] truncate">
                {auth.profileName ?? 'Connected'}
              </div>
              {lastSyncedAt && (
                <div className="mono text-[9.5px] text-[var(--color-text-tertiary)] mt-0.5">
                  {new Date(lastSyncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 text-[12px] text-[var(--color-text-tertiary)] max-lg:hidden max-lg:group-hover/sidebar:block">Not connected</div>
        )}
        <ThemeToggle />
      </div>
      </div>
      <LabelCreateModal
        open={labelModalOpen}
        onClose={() => { setLabelModalOpen(false); setEditingLabel(null); }}
        onSave={(label) => addLabel(label)}
        onDelete={(id) => removeLabel(id)}
        existingLabels={labels}
        editLabel={editingLabel}
      />
    </aside>
  );
}
