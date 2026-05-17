'use client';
import { useEffect, useMemo, useState } from 'react';
import { X, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Label } from '@/types';

const COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#0ea5e9',
  '#3b82f6', '#7c3aed', '#a78bfa', '#ec4899', '#94a3b8',
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (label: Label) => void;
  onDelete?: (id: string) => void;
  existingLabels: Label[];
  // When provided, the modal opens in edit mode for this label.
  editLabel?: Label | null;
}

export function LabelCreateModal({ open, onClose, onSave, onDelete, existingLabels, editLabel }: Props) {
  const isEdit = !!editLabel;
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [description, setDescription] = useState('');
  const [exclusiveGroup, setExclusiveGroup] = useState<string>(''); // '' = none
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingNewGroup, setCreatingNewGroup] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Pull existing groups from the labels list
  const existingGroups = useMemo(() => {
    const set = new Set<string>();
    for (const l of existingLabels) {
      if (l.exclusiveGroup) set.add(l.exclusiveGroup);
    }
    return [...set].sort();
  }, [existingLabels]);

  useEffect(() => {
    if (!open) return;
    if (editLabel) {
      setName(editLabel.name);
      setColor(editLabel.color);
      setDescription(editLabel.description ?? '');
      setExclusiveGroup(editLabel.exclusiveGroup ?? '');
    } else {
      setName('');
      setColor(COLORS[Math.floor(Math.random() * COLORS.length)]);
      setDescription('');
      setExclusiveGroup('');
    }
    setNewGroupName('');
    setCreatingNewGroup(false);
    setConfirmDelete(false);
  }, [open, editLabel]);

  if (!open) return null;

  const canSave = name.trim().length > 0;

  function handleSave() {
    if (!canSave) return;
    const finalGroup = creatingNewGroup ? newGroupName.trim() || null : (exclusiveGroup || null);
    const id = isEdit
      ? editLabel!.id
      : `user-${name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    onSave({
      id,
      name: name.trim(),
      color,
      description: description.trim() || null,
      aiManaged: description.trim().length > 0,
      exclusiveGroup: finalGroup,
    });
    onClose();
  }

  function handleDelete() {
    if (!editLabel || !onDelete) return;
    onDelete(editLabel.id);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="card max-w-md w-full p-6 bg-[var(--color-card)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
            {isEdit ? 'Edit label' : 'New label'}
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Name */}
        <div className="mb-4">
          <label className="block text-[11px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wide mb-1.5">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Asked for pricing"
            autoFocus
            className="w-full px-3 py-2 text-[13px] rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-hairline)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {/* Color */}
        <div className="mb-4">
          <label className="block text-[11px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wide mb-1.5">
            Color
          </label>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={cn(
                  'w-7 h-7 rounded-full border-2',
                  color === c ? 'border-[var(--color-text-primary)] scale-110' : 'border-transparent',
                )}
                style={{ background: c, transition: 'all 140ms var(--ease-out-quart)' }}
                title={c}
              />
            ))}
          </div>
        </div>

        {/* Description — the AI hook */}
        <div className="mb-4">
          <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wide mb-1.5">
            <Sparkles className="w-3 h-3 text-[var(--color-accent)]" />
            Description (AI rule)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="When should the AI apply this label? e.g. 'Apply when the sender is being rude, dismissive, or aggressive.'"
            rows={3}
            className="w-full px-3 py-2 text-[12.5px] rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-hairline)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] resize-none"
          />
          <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1.5 leading-relaxed">
            Leave blank for a manual-only label. With a description, AI applies it automatically when classifying conversations.
          </p>
        </div>

        {/* Exclusive group */}
        <div className="mb-5">
          <label className="block text-[11px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wide mb-1.5">
            Exclusive with
          </label>
          {!creatingNewGroup ? (
            <select
              value={exclusiveGroup}
              onChange={(e) => {
                if (e.target.value === '__new__') {
                  setCreatingNewGroup(true);
                } else {
                  setExclusiveGroup(e.target.value);
                }
              }}
              className="w-full px-3 py-2 text-[13px] rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-hairline)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">(none — can co-exist with anything)</option>
              {existingGroups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
              <option value="__new__">+ Create new group…</option>
            </select>
          ) : (
            <div className="flex items-center gap-2">
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="group-key (kebab-case)"
                className="flex-1 px-3 py-2 text-[13px] rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-hairline)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              />
              <button
                onClick={() => { setCreatingNewGroup(false); setNewGroupName(''); }}
                className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
              >
                Cancel
              </button>
            </div>
          )}
          <p className="text-[11px] text-[var(--color-text-tertiary)] mt-1.5 leading-relaxed">
            Labels in the same group can&apos;t co-exist on a conversation. Example: <code className="mono">interest-state</code> contains &ldquo;Interested&rdquo;, &ldquo;Not interested&rdquo;, &ldquo;Ghosted&rdquo;.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2">
          {isEdit && onDelete ? (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDelete}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[var(--color-danger)] hover:opacity-90 text-white"
                  style={{ transition: 'opacity 140ms var(--ease-out-quart)' }}
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-[12px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 rounded-md"
                style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
                title="Delete label (removes from all conversations)"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            )
          ) : <span />}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className={cn(
                'px-4 py-1.5 rounded-lg text-[12.5px] font-semibold',
                canSave
                  ? 'bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] cursor-not-allowed',
              )}
              style={{ transition: 'all 140ms var(--ease-out-quart)' }}
            >
              {isEdit ? 'Save changes' : 'Create label'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
