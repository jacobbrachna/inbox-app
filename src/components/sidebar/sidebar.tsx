'use client';
import { useState, useEffect } from 'react';
import {
  Inbox, Mail, Star, Clock, Archive, Settings,
  ChevronDown, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight,
  Plus, MessageSquare, TrendingUp, BarChart3, Activity, BellRing, Flame,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import type { FilterView } from '@/types';
import { ThemeToggle } from '@/components/theme/theme-toggle';

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
        'relative w-full flex items-center gap-3 px-3 py-2 rounded-[10px] text-[13px]',
        // Collapsed: center the only visible child (icon). Hover/expanded:
        // back to left-aligned for label + count layout.
        'max-lg:justify-center max-lg:group-hover/sidebar:justify-start',
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] font-medium'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]',
      )}
      style={{ transition: 'background-color 140ms var(--ease-out-quart), color 140ms var(--ease-out-quart)' }}
    >
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-5 pb-2 max-lg:hidden max-lg:group-hover/sidebar:block">
      <span className="eyebrow">{children}</span>
    </div>
  );
}

export function Sidebar() {
  const { auth, activeFilter, setActiveFilter, labels, addLabel, conversations, lastSyncedAt } = useStore();
  const [labelsOpen, setLabelsOpen] = useState(true);

  const unreadCount = conversations.filter((c) => c.status === 'unread').length;
  const starredCount = conversations.filter((c) => c.isStarred).length;
  const snoozedCount = conversations.filter((c) => c.status === 'snoozed').length;
  const now = Date.now();
  const overdueFollowUpCount = conversations.filter(
    (c) => !!c.followUpAt && new Date(c.followUpAt).getTime() < now,
  ).length;

  const labelCounts = labels.reduce(
    (acc, l) => ({ ...acc, [l.id]: conversations.filter((c) => c.labels.includes(l.id)).length }),
    {} as Record<string, number>,
  );

  function addNewLabel() {
    const name = window.prompt('Label name?');
    if (!name) return;
    const colors = ['#B5483A', '#E8B07A', '#D89568', '#5C7045', '#4A6878', '#9B85AA', '#C28FA0'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    addLabel({ id: name.toLowerCase().replace(/\s+/g, '-'), name, color });
  }

  return (
    <aside
      className={cn(
        'group/sidebar sidebar-root flex-shrink-0 relative',
        // Outer slot reserves 220px at lg+, 64px below. Inner is absolutely
        // positioned so it can overlay other columns when hovered.
        'w-[220px] max-lg:w-[64px]',
      )}
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
        <div className="leading-tight max-lg:hidden max-lg:group-hover/sidebar:block">
          <div className="text-[15px] font-semibold tracking-tight text-[var(--color-text-primary)]">
            InboxPro
          </div>
          <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">
            LinkedIn · Sales Nav
          </div>
        </div>
      </div>

      <div className="h-px bg-[var(--color-hairline)] mx-4" />

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

        <div className="px-3 pt-5 pb-1 max-lg:hidden max-lg:group-hover/sidebar:block">
          <div className="flex items-center">
            <button
              className="flex items-center gap-1 flex-1 eyebrow hover:text-[var(--color-text-secondary)]"
              onClick={() => setLabelsOpen(!labelsOpen)}
              style={{ transition: 'color 150ms var(--ease-out-quart)' }}
            >
              {labelsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Labels
            </button>
            <button
              onClick={addNewLabel}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-accent-deep)]"
              style={{ transition: 'color 150ms var(--ease-out-quart)' }}
              title="New label"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>
        {labelsOpen && (
          <div>
            {labels.map((label) => (
              <NavItem
                key={label.id}
                icon={<span className="w-2 h-2 rounded-full" style={{ backgroundColor: label.color }} />}
                label={label.name}
                count={labelCounts[label.id]}
                active={activeFilter === `label:${label.id}`}
                onClick={() => setActiveFilter(`label:${label.id}` as FilterView)}
              />
            ))}
          </div>
        )}

      </nav>

      <div className="h-px bg-[var(--color-hairline)] mx-4" />

      <div className="px-2 py-2">
        <NavItem
          icon={<Flame className="w-4 h-4" />}
          label="Outbound Queue"
          active={activeFilter === 'queue'}
          onClick={() => setActiveFilter('queue')}
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
    </aside>
  );
}
