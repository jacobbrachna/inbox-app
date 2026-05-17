'use client';
import { useEffect, useMemo, useState } from 'react';
import { Search, ArrowUp, ArrowDown, ExternalLink, Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/shared/avatar';

interface Contact {
  id: string;
  name: string;
  profileUrl: string | null;
  avatarUrl: string | null;
  headline: string | null;
  company: string | null;
  role: string | null;
  location: string | null;
  source: string | null;
  conversationCount: number;
  outboundCount: number;
  inboundCount: number;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

type SortKey = 'name' | 'company' | 'conversationCount' | 'lastOutboundAt' | 'lastSeenAt';
type SortDir = 'asc' | 'desc';

function relativeDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s).getTime();
  if (!d) return '—';
  const days = Math.floor((Date.now() - d) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const SOURCE_COLORS: Record<string, string> = {
  'linkedin-export': 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]',
  'dom-capture': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  'ai-headline': 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  'harvest': 'bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)]',
};

export function ContactsPanel() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('lastSeenAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/contacts')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setContacts(Array.isArray(d?.contacts) ? d.contacts : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = contacts;
    if (q) {
      rows = rows.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        (c.company ?? '').toLowerCase().includes(q) ||
        (c.role ?? '').toLowerCase().includes(q) ||
        (c.headline ?? '').toLowerCase().includes(q),
      );
    }
    const sorted = [...rows].sort((a, b) => {
      let av: string | number | null = a[sortKey];
      let bv: string | number | null = b[sortKey];
      if (av === null) av = sortKey === 'conversationCount' ? -1 : '';
      if (bv === null) bv = sortKey === 'conversationCount' ? -1 : '';
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const aS = String(av).toLowerCase();
      const bS = String(bv).toLowerCase();
      if (aS < bS) return sortDir === 'asc' ? -1 : 1;
      if (aS > bS) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [contacts, query, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'company' ? 'asc' : 'desc');
    }
  }

  const summary = useMemo(() => {
    const noOutbound = contacts.filter((c) => !c.lastOutboundAt).length;
    const sources = contacts.reduce<Record<string, number>>((acc, c) => {
      const k = c.source ?? 'unknown';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    return { total: contacts.length, noOutbound, sources };
  }, [contacts]);

  return (
    <div className="card flex-1 overflow-y-auto p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[var(--color-accent-soft)] flex items-center justify-center">
            <Users className="w-4 h-4 text-[var(--color-accent-deep)]" strokeWidth={2.25} />
          </div>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">Contacts</h1>
            <p className="text-[12px] text-[var(--color-text-tertiary)]">
              {summary.total} people · {summary.noOutbound} you haven&apos;t messaged yet
            </p>
          </div>
        </div>
      </div>

      {/* Source breakdown chips */}
      <div className="flex flex-wrap gap-2 mb-5">
        {Object.entries(summary.sources)
          .sort((a, b) => b[1] - a[1])
          .map(([src, n]) => (
            <span
              key={src}
              className={cn(
                'text-[11px] px-2 py-1 rounded-md font-medium',
                SOURCE_COLORS[src] ?? 'bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)]',
              )}
            >
              {src}: {n}
            </span>
          ))}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, company, role, headline…"
          className="w-full pl-9 pr-3 py-2 text-[13px] rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-hairline)] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      {/* Table */}
      <div className="border border-[var(--color-hairline)] rounded-lg overflow-hidden">
        <table className="w-full text-[12.5px]">
          <thead className="bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)]">
            <tr>
              <Th sortKey="name" current={sortKey} dir={sortDir} onClick={toggleSort}>Name</Th>
              <Th sortKey="company" current={sortKey} dir={sortDir} onClick={toggleSort}>Company / Role</Th>
              <Th sortKey="conversationCount" current={sortKey} dir={sortDir} onClick={toggleSort} align="right">Threads</Th>
              <Th sortKey="lastOutboundAt" current={sortKey} dir={sortDir} onClick={toggleSort} align="right">Last outbound</Th>
              <Th sortKey="lastSeenAt" current={sortKey} dir={sortDir} onClick={toggleSort} align="right">Last seen</Th>
              <th className="px-3 py-2 text-right font-medium w-12">Source</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-[var(--color-text-tertiary)]">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-[var(--color-text-tertiary)]">
                {query ? 'No matches.' : 'No contacts yet.'}
              </td></tr>
            ) : (
              filtered.map((c) => (
                <tr key={c.id} className="border-t border-[var(--color-hairline)] hover:bg-[var(--color-surface-2)]">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={c.name} src={c.avatarUrl ?? undefined} size="sm" />
                      <div className="min-w-0">
                        <div className="font-medium text-[var(--color-text-primary)] truncate">{c.name}</div>
                        {c.headline && (
                          <div className="text-[11px] text-[var(--color-text-tertiary)] truncate max-w-[280px]">{c.headline}</div>
                        )}
                      </div>
                      {c.profileUrl && (
                        <a
                          href={c.profileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)]"
                          title="Open LinkedIn profile"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[var(--color-text-secondary)]">
                    {c.company || '—'}
                    {c.role && <div className="text-[11px] text-[var(--color-text-tertiary)] truncate max-w-[200px]">{c.role}</div>}
                  </td>
                  <td className="px-3 py-2 text-right mono tabular-nums text-[var(--color-text-secondary)]">{c.conversationCount}</td>
                  <td className="px-3 py-2 text-right text-[var(--color-text-tertiary)]">{relativeDate(c.lastOutboundAt)}</td>
                  <td className="px-3 py-2 text-right text-[var(--color-text-tertiary)]">{relativeDate(c.lastSeenAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded font-medium',
                      SOURCE_COLORS[c.source ?? ''] ?? 'bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)]',
                    )}>
                      {c.source ?? '—'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > 0 && (
        <p className="mt-3 text-[11px] text-[var(--color-text-tertiary)] text-right">
          {filtered.length}{filtered.length !== contacts.length && ` of ${contacts.length}`} contacts
        </p>
      )}
    </div>
  );
}

function Th({
  children, sortKey, current, dir, onClick, align,
}: {
  children: React.ReactNode;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sortKey === current;
  return (
    <th className={cn('px-3 py-2 font-medium', align === 'right' ? 'text-right' : 'text-left')}>
      <button
        onClick={() => onClick(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-[var(--color-text-primary)]',
          active && 'text-[var(--color-text-primary)]',
        )}
      >
        {children}
        {active && (dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </th>
  );
}
