'use client';
import { useEffect, useRef, useState } from 'react';
import { Star, Archive, Clock, BellRing, Tag, Mail, MailOpen, Trash2, Check, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import type { Conversation } from '@/types';

interface Props {
  conversation: Conversation;
  x: number;
  y: number;
  onClose: () => void;
}

// Right-click menu for a conversation row. Quick access to the actions you'd
// otherwise hunt for in the thread header — and notably, label assignment in
// one click instead of three.
export function ConvContextMenu({ conversation, x, y, onClose }: Props) {
  const { updateConversation, deleteConversation, labels, addLabel } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [showLabels, setShowLabels] = useState(false);
  const [newLabel, setNewLabel] = useState('');

  // Close on outside click / Escape
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  function toggleLabel(labelId: string) {
    const next = conversation.labels.includes(labelId)
      ? conversation.labels.filter((l) => l !== labelId)
      : [...conversation.labels, labelId];
    updateConversation(conversation.id, { labels: next });
  }

  function createAndApply() {
    const name = newLabel.trim();
    if (!name) return;
    const palette = ['#2563EB', '#16A34A', '#DC2626', '#7C3AED', '#0891B2', '#D97706', '#475569', '#E11D48'];
    const color = palette[Math.floor(Math.random() * palette.length)];
    const id = name.toLowerCase().replace(/\s+/g, '-');
    addLabel({ id, name, color });
    updateConversation(conversation.id, { labels: [...conversation.labels, id] });
    setNewLabel('');
    onClose();
  }

  function unsnooze() {
    updateConversation(conversation.id, { status: 'read', snoozedUntil: null });
  }
  function snoozeDay() {
    updateConversation(conversation.id, {
      status: 'snoozed',
      snoozedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  function followUp(daysFromNow: number) {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    d.setHours(9, 0, 0, 0);
    updateConversation(conversation.id, { followUpAt: d.toISOString() });
    onClose();
  }

  const isUnread = conversation.status === 'unread';
  const isSnoozed = conversation.status === 'snoozed';

  // Clamp position so the menu stays on screen
  const menuW = 220;
  const menuH = 360;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <div
      ref={ref}
      className="fixed z-[100] bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl py-1 w-[220px] overflow-hidden"
      style={{
        top,
        left,
        boxShadow: 'var(--shadow-raised)',
      }}
    >
      {!showLabels ? (
        <>
          <MenuItem
            icon={<Star className={cn('w-3.5 h-3.5', conversation.isStarred && 'fill-current text-[var(--color-accent)]')} />}
            label={conversation.isStarred ? 'Unstar' : 'Star'}
            shortcut="S"
            onClick={() => { updateConversation(conversation.id, { isStarred: !conversation.isStarred }); onClose(); }}
          />
          <MenuItem
            icon={isUnread ? <MailOpen className="w-3.5 h-3.5" /> : <Mail className="w-3.5 h-3.5" />}
            label={isUnread ? 'Mark as read' : 'Mark as unread'}
            onClick={() => { updateConversation(conversation.id, { status: isUnread ? 'read' : 'unread' }); onClose(); }}
          />
          <MenuItem
            icon={<Tag className="w-3.5 h-3.5" />}
            label={conversation.labels.length > 0 ? `Labels (${conversation.labels.length})` : 'Add label'}
            chevron
            onClick={() => setShowLabels(true)}
          />
          <Divider />
          <MenuItem
            icon={<Clock className="w-3.5 h-3.5" />}
            label={isSnoozed ? 'Unsnooze' : 'Snooze 24h'}
            shortcut="H"
            onClick={() => { isSnoozed ? unsnooze() : snoozeDay(); onClose(); }}
          />
          <MenuItem
            icon={<BellRing className="w-3.5 h-3.5" />}
            label="Follow up in 3 days"
            onClick={() => followUp(3)}
          />
          <MenuItem
            icon={<BellRing className="w-3.5 h-3.5" />}
            label="Follow up in 1 week"
            onClick={() => followUp(7)}
          />
          <Divider />
          <MenuItem
            icon={<Archive className="w-3.5 h-3.5" />}
            label="Archive"
            shortcut="E"
            onClick={() => { updateConversation(conversation.id, { status: 'archived' }); onClose(); }}
          />
          <MenuItem
            icon={<Trash2 className="w-3.5 h-3.5" />}
            label="Delete"
            danger
            onClick={() => {
              if (window.confirm('Delete this conversation? Mirrors to LinkedIn if mirror is on.')) {
                deleteConversation(conversation.id);
              }
              onClose();
            }}
          />
        </>
      ) : (
        <>
          <div className="px-3 py-2 flex items-center justify-between border-b border-[var(--color-hairline)]">
            <span className="eyebrow">Apply labels</span>
            <button
              onClick={() => setShowLabels(false)}
              className="text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
              style={{ transition: 'color 140ms var(--ease-out-quart)' }}
            >
              Back
            </button>
          </div>
          {labels.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">No labels yet — create one below.</p>
          )}
          {labels.map((l) => {
            const isOn = conversation.labels.includes(l.id);
            return (
              <button
                key={l.id}
                onClick={() => toggleLabel(l.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-[var(--color-card-hover)]"
                style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
                <span className="flex-1 text-left text-[var(--color-text-primary)]">{l.name}</span>
                {isOn && <Check className="w-3 h-3 text-[var(--color-accent)]" />}
              </button>
            );
          })}
          <Divider />
          <div className="px-2 py-1.5 flex items-center gap-1.5">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  createAndApply();
                }
              }}
              placeholder="New label name…"
              autoFocus
              className="flex-1 px-2 py-1 text-[12px] bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded outline-none focus:border-[var(--color-accent)] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)]"
              style={{ transition: 'border-color 140ms var(--ease-out-quart)' }}
            />
            <button
              onClick={createAndApply}
              disabled={!newLabel.trim()}
              className="px-2 py-1 rounded text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ transition: 'all 140ms var(--ease-out-quart)' }}
              title="Create + apply"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  shortcut,
  danger,
  chevron,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] hover:bg-[var(--color-card-hover)]',
        danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]',
      )}
      style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
    >
      <span className={danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-tertiary)]'}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {chevron && <span className="text-[var(--color-text-tertiary)] text-[12px]">›</span>}
      {shortcut && (
        <kbd className="mono text-[9.5px] text-[var(--color-text-tertiary)] bg-[var(--color-surface)] px-1 py-0.5 rounded">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

function Divider() {
  return <div className="h-px bg-[var(--color-hairline)] my-1" />;
}
