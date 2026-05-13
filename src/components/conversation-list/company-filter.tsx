'use client';
import { useEffect, useRef, useState } from 'react';
import { Building2, X, Search, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import type { FilterView } from '@/types';

interface Company { name: string; count: number; }

// Slim "Filter by company" control that sits below the search bar in the
// conv list. Two states:
//   • Idle  → small "+ Company" chip; click opens a popover with searchable list
//   • Active → chip shows the current filter name; click × clears it
export function CompanyFilter() {
  const { activeFilter, setActiveFilter, conversations } = useStore();
  const [open, setOpen] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [query, setQuery] = useState('');
  const popRef = useRef<HTMLDivElement>(null);

  // Fetch companies whenever conv data shifts (new enrichments arrive)
  useEffect(() => {
    let cancelled = false;
    fetch('/api/companies')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setCompanies(Array.isArray(d.companies) ? d.companies : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [conversations.length]);

  // Close popover on outside click / Escape
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeCompany = activeFilter?.startsWith('company:')
    ? activeFilter.replace('company:', '')
    : null;

  const filtered = query.trim()
    ? companies.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    : companies;

  function pick(name: string) {
    setActiveFilter(`company:${name}` as FilterView);
    setOpen(false);
    setQuery('');
  }

  function clear() {
    setActiveFilter('all');
  }

  if (companies.length === 0) return null;

  return (
    <div className="relative">
      {activeCompany ? (
        <div className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] text-[11px] font-medium">
          <Building2 className="w-3 h-3" />
          <span className="max-w-[160px] truncate">{activeCompany}</span>
          <button
            onClick={clear}
            className="inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-[var(--color-accent)]/30"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
            title="Clear filter"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-dashed border-[var(--color-hairline)] text-[10.5px] font-medium text-[var(--color-text-tertiary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          <Building2 className="w-3 h-3" />
          Filter by company
        </button>
      )}

      {open && (
        <div
          ref={popRef}
          className="absolute top-full left-0 mt-1 z-50 w-[260px] bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl overflow-hidden"
          style={{ boxShadow: 'var(--shadow-raised)' }}
        >
          <div className="px-3 py-2 border-b border-[var(--color-hairline)]">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--color-text-tertiary)]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search companies…"
                className="w-full pl-7 pr-2 py-1 text-[12px] bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded outline-none focus:border-[var(--color-accent)] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)]"
                style={{ transition: 'border-color 140ms var(--ease-out-quart)' }}
              />
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[11.5px] text-[var(--color-text-tertiary)] text-center">No matches</p>
            ) : (
              filtered.slice(0, 200).map((co) => (
                <button
                  key={co.name}
                  onClick={() => pick(co.name)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-left',
                    'hover:bg-[var(--color-card-hover)]',
                    activeCompany === co.name && 'bg-[var(--color-accent-soft)]',
                  )}
                  style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
                >
                  <Building2 className="w-3 h-3 text-[var(--color-text-tertiary)] flex-shrink-0" />
                  <span className="flex-1 truncate text-[var(--color-text-primary)]">{co.name}</span>
                  <span className="mono text-[10px] text-[var(--color-text-tertiary)]">{co.count}</span>
                  {activeCompany === co.name && <Check className="w-3 h-3 text-[var(--color-accent)]" />}
                </button>
              ))
            )}
            {filtered.length > 200 && (
              <p className="px-3 py-2 text-[10px] text-[var(--color-text-tertiary)] text-center">
                Showing top 200 — keep typing to narrow
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
