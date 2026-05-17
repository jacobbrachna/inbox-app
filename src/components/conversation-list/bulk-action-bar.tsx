'use client';
import { useEffect, useRef, useState } from 'react';
import { Archive, Mail, MailOpen, Star, Tag, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';

interface BulkActionBarProps {
  /** Number of conversations currently visible under the active filter. */
  visibleCount: number;
}

export function BulkActionBar({ visibleCount }: BulkActionBarProps) {
  const {
    selectedIds,
    clearSelection,
    selectAll,
    bulkUpdate,
    bulkDelete,
    labels,
  } = useStore();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [working, setWorking] = useState(false);
  const labelPickerRef = useRef<HTMLDivElement>(null);

  const count = selectedIds.size;
  const allSelected = count > 0 && count >= visibleCount;

  // Close label dropdown on outside click
  useEffect(() => {
    if (!showLabels) return;
    function onClick(e: MouseEvent) {
      if (
        labelPickerRef.current &&
        !labelPickerRef.current.contains(e.target as Node)
      ) {
        setShowLabels(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showLabels]);

  async function runUpdate(patch: Parameters<typeof bulkUpdate>[0]) {
    if (working) return;
    setWorking(true);
    try {
      await bulkUpdate(patch);
    } finally {
      setWorking(false);
    }
  }

  async function runDelete() {
    if (working) return;
    setWorking(true);
    try {
      await bulkDelete();
      setConfirmDelete(false);
    } finally {
      setWorking(false);
    }
  }

  function applyLabel(labelId: string) {
    // Add this label to every selected conversation (union with existing labels).
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setShowLabels(false);
    const store = useStore.getState();
    const update = store.updateConversation;
    const convos = store.conversations;

    // Run in waves of 10 to throttle parallel PATCHes.
    (async () => {
      setWorking(true);
      const BATCH = 10;
      try {
        for (let i = 0; i < ids.length; i += BATCH) {
          const slice = ids.slice(i, i + BATCH);
          slice.forEach((id) => {
            const convo = convos.find((c) => c.id === id);
            if (!convo) return;
            if (convo.labels.includes(labelId)) return;
            update(id, { labels: [...convo.labels, labelId] });
          });
          if (i + BATCH < ids.length) await new Promise((r) => setTimeout(r, 0));
        }
        store.clearSelection();
      } finally {
        setWorking(false);
      }
    })();
  }

  return (
    <div
      className="px-4 py-3 border-b border-[var(--color-hairline)] bg-[var(--color-surface)]"
      style={{ animation: 'row-in var(--dur-medium) var(--ease-spring-gentle) both' }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="font-semibold text-[var(--color-text-primary)]">{count} selected</span>
          <button
            onClick={() => (allSelected ? clearSelection() : selectAll())}
            className="eyebrow text-[var(--color-accent-deep)] hover:text-[var(--color-text-primary)]"
            style={{ transition: 'color 150ms var(--ease-out-quart)' }}
          >
            {allSelected ? 'Clear' : `Select all ${visibleCount}`}
          </button>
        </div>
        <button
          onClick={clearSelection}
          className="p-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          style={{ transition: 'color 150ms var(--ease-out-quart)' }}
          title="Cancel selection"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1 flex-wrap">
        <ActionBtn
          icon={<Archive className="w-3.5 h-3.5" />}
          label="Archive"
          disabled={working}
          onClick={() => runUpdate({ status: 'archived' })}
        />
        <ActionBtn
          icon={<MailOpen className="w-3.5 h-3.5" />}
          label="Read"
          disabled={working}
          onClick={() => runUpdate({ status: 'read', unreadCount: 0 })}
        />
        <ActionBtn
          icon={<Mail className="w-3.5 h-3.5" />}
          label="Unread"
          disabled={working}
          onClick={() => runUpdate({ status: 'unread' })}
        />
        <ActionBtn
          icon={<Star className="w-3.5 h-3.5" />}
          label="Star"
          disabled={working}
          onClick={() => runUpdate({ isStarred: true })}
        />

        {/* Label dropdown */}
        <div className="relative" ref={labelPickerRef}>
          <ActionBtn
            icon={<Tag className="w-3.5 h-3.5" />}
            label="Label"
            disabled={working}
            onClick={() => setShowLabels((v) => !v)}
          />
          {showLabels && (
            <div
              className="absolute top-full left-0 mt-1 z-50 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl w-52 py-1 overflow-hidden"
              style={{ boxShadow: 'var(--shadow-raised)' }}
            >
              <p className="eyebrow px-4 py-2">Apply label</p>
              {labels.length === 0 && (
                <p className="px-4 py-2 text-[12px] text-[var(--color-text-tertiary)]">No labels yet</p>
              )}
              {labels.map((l) => (
                <button
                  key={l.id}
                  onClick={() => applyLabel(l.id)}
                  className="w-full flex items-center gap-3 px-4 py-2 text-[13px] hover:bg-[var(--color-card-hover)]"
                  style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
                >
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
                  <span className="flex-1 text-left text-[var(--color-text-primary)]">{l.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <ActionBtn
          icon={<Trash2 className="w-3.5 h-3.5" />}
          label="Delete"
          disabled={working}
          onClick={() => setConfirmDelete(true)}
          danger
        />
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div
            className="bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-2xl p-6 w-96"
            style={{ boxShadow: 'var(--shadow-raised)' }}
          >
            <h3 className="text-[16px] font-semibold text-[var(--color-text-primary)] mb-2">
              Delete {count} conversation{count === 1 ? '' : 's'}?
            </h3>
            <p className="text-[13px] text-[var(--color-text-secondary)] mb-5">
              This removes them from InboxPro.{' '}
              <strong className="text-[var(--color-text-primary)]">
                Does not delete from LinkedIn unless mirror is enabled.
              </strong>
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={working}
                className="px-4 py-2 text-[13px] font-medium text-[var(--color-text-secondary)] rounded-lg hover:bg-[var(--color-card-hover)] disabled:opacity-50"
                style={{ transition: 'all 140ms var(--ease-out-quart)' }}
              >
                Cancel
              </button>
              <button
                onClick={runDelete}
                disabled={working}
                className="px-4 py-2 text-[13px] font-semibold text-white bg-[var(--color-danger)] hover:opacity-90 rounded-lg disabled:opacity-50"
                style={{ transition: 'all 140ms var(--ease-out-quart)' }}
              >
                {working ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-medium border',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        danger
          ? 'text-[var(--color-text-secondary)] border-transparent hover:border-[var(--color-danger)]/30 hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10'
          : 'text-[var(--color-text-secondary)] border-transparent hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)] hover:border-[var(--color-hairline)]',
      )}
      style={{ transition: 'all 150ms var(--ease-out-quart)' }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

