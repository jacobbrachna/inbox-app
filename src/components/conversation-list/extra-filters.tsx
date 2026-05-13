'use client';
import { useEffect, useRef, useState } from 'react';
import { Briefcase, Clock, StickyNote, X, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import type { FilterView } from '@/types';

// ──────────────────────────────────────────────────────────────────────────
// Role filter — text input. Type any substring (e.g. "VP", "Engineer") to
// narrow contacts by enrichment.role. Stored as `role:<query>`.
// ──────────────────────────────────────────────────────────────────────────
export function RoleFilter() {
  const { activeFilter, setActiveFilter } = useStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeRole = activeFilter?.startsWith('role:')
    ? activeFilter.replace('role:', '')
    : null;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function apply() {
    const t = draft.trim();
    if (!t) return;
    setActiveFilter(`role:${t}` as FilterView);
    setOpen(false);
    setDraft('');
  }

  function clear() { setActiveFilter('all'); }

  return (
    <div className="relative">
      {activeRole ? (
        <div className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] text-[11px] font-medium">
          <Briefcase className="w-3 h-3" />
          <span className="max-w-[160px] truncate">role contains &ldquo;{activeRole}&rdquo;</span>
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
          <Briefcase className="w-3 h-3" />
          Filter by role
        </button>
      )}

      {open && (
        <div
          ref={popRef}
          className="absolute top-full left-0 mt-1 z-50 w-[240px] bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl p-3"
          style={{ boxShadow: 'var(--shadow-raised)' }}
        >
          <p className="eyebrow mb-2">Role contains</p>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
            placeholder='e.g. "VP", "Engineer"'
            className="w-full px-2 py-1.5 text-[12px] bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded outline-none focus:border-[var(--color-accent)] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)]"
            style={{ transition: 'border-color 140ms var(--ease-out-quart)' }}
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              onClick={() => setOpen(false)}
              className="px-2.5 py-1 text-[11px] text-[var(--color-text-tertiary)] rounded hover:bg-[var(--color-card-hover)]"
              style={{ transition: 'all 140ms var(--ease-out-quart)' }}
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={!draft.trim()}
              className="px-2.5 py-1 text-[11px] font-semibold bg-[var(--color-accent-deep)] text-white rounded hover:bg-[var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ transition: 'all 140ms var(--ease-out-quart)' }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Recency filter — three presets via popover. Stored as `recency:7d|30d|older`.
// ──────────────────────────────────────────────────────────────────────────
const RECENCY_OPTIONS: Array<{ key: 'recency:7d' | 'recency:30d' | 'recency:older'; label: string; }> = [
  { key: 'recency:7d',    label: 'Last 7 days' },
  { key: 'recency:30d',   label: 'Last 30 days' },
  { key: 'recency:older', label: 'Older than 30 days' },
];

export function RecencyFilter() {
  const { activeFilter, setActiveFilter } = useStore();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  const active = activeFilter?.startsWith('recency:')
    ? RECENCY_OPTIONS.find((o) => o.key === activeFilter) ?? null
    : null;

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

  return (
    <div className="relative">
      {active ? (
        <div className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] text-[11px] font-medium">
          <Clock className="w-3 h-3" />
          <span>{active.label}</span>
          <button
            onClick={() => setActiveFilter('all')}
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
          <Clock className="w-3 h-3" />
          Filter by recency
        </button>
      )}

      {open && (
        <div
          ref={popRef}
          className="absolute top-full left-0 mt-1 z-50 w-[200px] bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl py-1 overflow-hidden"
          style={{ boxShadow: 'var(--shadow-raised)' }}
        >
          {RECENCY_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => { setActiveFilter(opt.key); setOpen(false); }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-left',
                'hover:bg-[var(--color-card-hover)]',
                active?.key === opt.key && 'bg-[var(--color-accent-soft)]',
              )}
              style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
            >
              <span className="flex-1 text-[var(--color-text-primary)]">{opt.label}</span>
              {active?.key === opt.key && <Check className="w-3 h-3 text-[var(--color-accent)]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Has-notes toggle — exclusive filter, single-click chip.
// ──────────────────────────────────────────────────────────────────────────
export function HasNotesFilter() {
  const { activeFilter, setActiveFilter } = useStore();
  const isActive = activeFilter === 'has-notes';
  return isActive ? (
    <div className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] text-[11px] font-medium">
      <StickyNote className="w-3 h-3" />
      <span>Has notes</span>
      <button
        onClick={() => setActiveFilter('all')}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-[var(--color-accent)]/30"
        style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        title="Clear filter"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  ) : (
    <button
      onClick={() => setActiveFilter('has-notes')}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-dashed border-[var(--color-hairline)] text-[10.5px] font-medium text-[var(--color-text-tertiary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      style={{ transition: 'all 140ms var(--ease-out-quart)' }}
    >
      <StickyNote className="w-3 h-3" />
      Has notes
    </button>
  );
}
