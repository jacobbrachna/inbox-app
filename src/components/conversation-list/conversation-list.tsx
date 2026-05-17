'use client';
import { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, ChevronDown, Sparkles, X, Inbox as InboxIcon, SearchX } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import { ConversationItem } from './conversation-item';
import { BulkActionBar } from './bulk-action-bar';
import { CompanyFilter } from './company-filter';
import { RoleFilter, RecencyFilter, HasNotesFilter } from './extra-filters';
import { filterConversations } from '@/lib/filter';
import { useResizableColumn } from '@/lib/use-resizable-column';
import { isExtensionReady } from '@/lib/use-extension-ready';

export function ConversationList() {
  const {
    conversations, activeFilter, searchQuery, setSearchQuery,
    setActiveConversationId, activeConversationId, loadFromServer,
    selectedIds, labels, currentRoleOnly, currentRoleStart,
  } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [smartMode, setSmartMode] = useState(false);
  const [smartIds, setSmartIds] = useState<Set<string> | null>(null);
  const [smartLoading, setSmartLoading] = useState(false);
  const [smartError, setSmartError] = useState<string | null>(null);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type === 'inboxpro-refresh-progress') {
        setRefreshMsg(ev.data.message);
      }
      if (ev.data.type === 'inboxpro-refresh-result') {
        const r = ev.data.response;
        setRefreshing(false);
        if (r?.ok) {
          setRefreshMsg(r.newConvs > 0 ? `+${r.newConvs} new · +${r.newMsgs ?? 0} msgs` : 'Up to date');
          loadFromServer();
        } else {
          setRefreshMsg(r?.reason ?? 'Refresh failed');
        }
        setTimeout(() => setRefreshMsg(null), 4000);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadFromServer]);

  function handleRefresh() {
    if (!isExtensionReady()) {
      setRefreshMsg('Extension not loaded — install / reload it.');
      setTimeout(() => setRefreshMsg(null), 4000);
      return;
    }
    setRefreshing(true);
    setRefreshMsg('Checking LinkedIn…');
    window.postMessage({ type: 'inboxpro-refresh-request' }, '*');
    setTimeout(() => {
      setRefreshing((r) => {
        if (r) setRefreshMsg('Still working… data will appear when sync finishes.');
        return false;
      });
    }, 120_000);
  }

  // Smart-mode search runs on Enter and replaces the filter with the AI result set
  async function runSmartSearch() {
    if (!searchQuery.trim()) return;
    setSmartLoading(true);
    setSmartError(null);
    try {
      const r = await fetch('/api/ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery.trim() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg: string = err.error ?? `HTTP ${r.status}`;
        setSmartError(msg.startsWith('NO_API_KEY') ? 'Add your Anthropic API key in Settings.' : msg);
        return;
      }
      const data = await r.json();
      setSmartIds(new Set<string>(Array.isArray(data.matches) ? data.matches : []));
    } catch (e) {
      setSmartError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSmartLoading(false);
    }
  }

  function exitSmart() {
    setSmartMode(false);
    setSmartIds(null);
    setSmartError(null);
  }

  const filtered = useMemo(() => {
    const roleStart = currentRoleOnly && currentRoleStart ? new Date(currentRoleStart) : null;
    if (smartMode && smartIds) {
      // Preserve recency order from `conversations`, intersect with smart results
      const base = conversations.filter((c) => smartIds.has(c.id));
      return roleStart
        ? base.filter((c) => new Date(c.lastMessageAt).getTime() >= roleStart.getTime())
        : base;
    }
    return filterConversations(conversations, activeFilter, searchQuery, roleStart);
  }, [conversations, activeFilter, searchQuery, smartMode, smartIds, currentRoleOnly, currentRoleStart]);

  const totalUnread = conversations.filter((c) => c.status === 'unread').length;

  function getTitle() {
    if (activeFilter === 'all') return 'Inbox';
    if (activeFilter === 'unread') return 'Unread';
    if (activeFilter === 'starred') return 'Starred';
    if (activeFilter === 'snoozed') return 'Snoozed';
    if (activeFilter === 'drafts') return 'Drafts';
    if (activeFilter === 'follow-up') return 'Follow up';
    if (activeFilter === 'archived') return 'Archived';
    if (activeFilter === 'linkedin') return 'LinkedIn DMs';
    if (activeFilter === 'sales_nav') return 'Sales Navigator';
    if (activeFilter?.startsWith('label:')) {
      const labelId = activeFilter.replace('label:', '');
      return labels.find((l) => l.id === labelId)?.name ?? labelId;
    }
    if (activeFilter?.startsWith('company:')) return activeFilter.replace('company:', '');
    if (activeFilter?.startsWith('role:')) return `Role: ${activeFilter.replace('role:', '')}`;
    if (activeFilter === 'recency:7d') return 'Last 7 days';
    if (activeFilter === 'recency:30d') return 'Last 30 days';
    if (activeFilter === 'recency:older') return 'Older than 30 days';
    if (activeFilter === 'has-notes') return 'Has notes';
    return 'Inbox';
  }

  const { width: convListWidth, startDrag, elRef } = useResizableColumn({
    storageKey: 'conv-list',
    defaultWidth: 360,
    min: 280,
    max: 480,
  });

  return (
    // Outer wrapper has NO overflow clipping — drag handle lives here.
    // Inner card keeps overflow-hidden so scrollable content + rounded corners work.
    <div ref={elRef} className="flex-shrink-0 relative" style={{ width: `${convListWidth}px` }}>
      {/* Drag handle — sits in the gap between this card and the next, full
          height, easy to grab. Lives in the OUTER wrapper so overflow-hidden
          on the card doesn't clip it. */}
      <div
        onMouseDown={startDrag}
        className="group absolute -right-3 top-0 bottom-0 w-3 cursor-col-resize z-20"
        title="Drag to resize"
      >
        <div
          className="absolute left-1/2 top-2 bottom-2 -translate-x-1/2 w-[2px] rounded-full bg-transparent group-hover:bg-[var(--color-accent)]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        />
      </div>
      <div className="card w-full h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-5 pb-3 border-b border-[var(--color-hairline)]">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-text-primary)]">
            {getTitle()}
          </h2>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
            style={{ transition: 'all 180ms var(--ease-out-quart)' }}
            title="Refresh"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex items-center gap-1 text-[12px] text-[var(--color-text-secondary)]">
            <span>Open ({filtered.length})</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </div>
          {totalUnread > 0 ? (
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-accent-fg)] bg-[var(--color-accent-soft)] px-2 py-0.5 rounded-full tabular-nums">
              <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
              {totalUnread} unread
            </span>
          ) : (
            <span className="ml-auto text-[12px] text-[var(--color-text-tertiary)]">Newest</span>
          )}
        </div>
        {/* Search */}
        <div className="relative">
          {smartMode ? (
            <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-accent)]" />
          ) : (
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
          )}
          <input
            type="text"
            placeholder={smartMode ? 'Ask anything — "asked about pricing"…' : 'Search conversations…'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (smartMode && e.key === 'Enter') {
                e.preventDefault();
                runSmartSearch();
              }
              if (e.key === 'Escape' && searchQuery.length > 0) {
                e.preventDefault();
                setSearchQuery('');
              }
            }}
            className={cn(
              'w-full pl-9 pr-20 py-2 text-[13px] bg-[var(--color-surface)] text-[var(--color-text-primary)] border rounded-lg outline-none focus:bg-[var(--color-card)] placeholder-[var(--color-text-tertiary)]',
              smartMode
                ? 'border-[var(--color-accent)]'
                : 'border-[var(--color-hairline)] focus:border-[var(--color-accent)]',
            )}
            style={{ transition: 'all 180ms var(--ease-out-quart)' }}
          />
          {/* Clear (×) — only when there's text to clear */}
          {searchQuery.length > 0 && !smartMode && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-[58px] top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
              style={{ transition: 'background-color 140ms var(--ease-out-quart), color 140ms var(--ease-out-quart)' }}
              title="Clear search (Esc)"
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={() => {
              if (smartMode) exitSmart();
              else setSmartMode(true);
            }}
            className={cn(
              'absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold',
              smartMode
                ? 'bg-[var(--color-accent)] text-white'
                : 'bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent-fg)]',
            )}
            style={{ transition: 'background-color 160ms var(--ease-out-quart), color 160ms var(--ease-out-quart)' }}
            title={smartMode ? 'Exit AI search' : 'Switch to AI search'}
          >
            {smartMode ? (
              <>AI <X className="w-2.5 h-2.5" /></>
            ) : (
              <><Sparkles className="w-2.5 h-2.5" /> AI</>
            )}
          </button>
        </div>
        {smartMode && (
          <p className="mt-1.5 text-[11px] text-[var(--color-text-tertiary)]">
            {smartLoading ? 'Searching…' :
              smartError ? <span className="text-[var(--color-danger)]">{smartError}</span> :
              smartIds ? `${smartIds.size} matches` :
              'Press Enter to search by meaning'}
          </p>
        )}
        {/* Filter chips — exclusive, replace the current view filter when clicked */}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <CompanyFilter />
          <RoleFilter />
          <RecencyFilter />
          <HasNotesFilter />
        </div>
        {refreshMsg && (
          <p className="mt-2 text-[11px] mono text-[var(--color-text-tertiary)]">{refreshMsg}</p>
        )}
      </div>

      {selectedIds.size > 0 && <BulkActionBar visibleCount={filtered.length} />}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12 gap-4">
            <div className="w-14 h-14 rounded-2xl bg-[var(--color-surface-2)] flex items-center justify-center text-[var(--color-text-tertiary)]">
              {conversations.length === 0 ? (
                <InboxIcon className="w-6 h-6" strokeWidth={1.5} />
              ) : (
                <SearchX className="w-6 h-6" strokeWidth={1.5} />
              )}
            </div>
            <div className="flex flex-col gap-1.5 max-w-[240px]">
              <span className="text-[14px] font-semibold tracking-tight text-[var(--color-text-primary)]">
                {conversations.length === 0 ? 'Your inbox is empty' : 'Nothing matches'}
              </span>
              <span className="text-[12px] text-[var(--color-text-tertiary)] leading-relaxed">
                {conversations.length === 0
                  ? 'Click sync to pull your LinkedIn and Sales Nav conversations.'
                  : 'Try a different filter or clear the search to see more.'}
              </span>
            </div>
          </div>
        ) : (
          // Key on activeFilter so React swaps the list wrapper when the
          // filter changes — re-firing the thread-fade animation for a
          // gentle cross-fade between Inbox / Unread / Starred / labels.
          <div key={activeFilter} className="thread-fade flex flex-col gap-0.5">
            {filtered.map((convo) => (
              <ConversationItem
                key={convo.id}
                conversation={convo}
                isActive={convo.id === activeConversationId}
                onClick={() => setActiveConversationId(convo.id)}
              />
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
