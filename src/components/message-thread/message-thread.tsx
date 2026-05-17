'use client';
import { useState, useEffect, useRef } from 'react';
import {
  Send, Star, Clock, Archive, ArchiveRestore, Tag, ExternalLink, Download, Trash2, Sparkles,
  MessageSquare, X, Check, AlertCircle, BellRing, StickyNote, ChevronDown, ChevronRight, Calendar,
  Pencil, ThumbsDown,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { hueForName } from '@/lib/color-for-name';
import { isExtensionReady } from '@/lib/use-extension-ready';
import { useStore } from '@/store';
import { Avatar } from '@/components/shared/avatar';
import { Badge } from '@/components/shared/badge';
import type { Message } from '@/types';
import { format, formatDistanceToNowStrict } from 'date-fns';

// Follow-up banner — shown at the top of the thread when a follow-up is set.
// AI-detected follow-ups show with a Sparkles tag + the phrase that triggered
// detection. Manual ones show just the date. Both have inline date editing
// and a dismiss button.
function FollowUpBanner({
  conversationId,
  followUpAt,
  followUpReason,
  followUpSource,
  followUpConfidence,
  onUpdate,
}: {
  conversationId: string;
  followUpAt: string;
  followUpReason: string | null | undefined;
  followUpSource: 'manual' | 'ai' | null | undefined;
  followUpConfidence: 'high' | 'low' | null | undefined;
  onUpdate: (id: string, patch: { followUpAt?: string | null; followUpSource?: 'manual' | 'ai' | null }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const date = new Date(followUpAt);
  const dueMs = date.getTime();
  const now = Date.now();
  const daysFromNow = Math.round((dueMs - now) / (24 * 60 * 60 * 1000));

  const overdue = dueMs < now;
  const isAI = followUpSource === 'ai';
  const isLowConfidence = followUpConfidence === 'low';

  const dueLabel = overdue
    ? `${Math.abs(daysFromNow)}d overdue`
    : daysFromNow === 0
    ? 'Due today'
    : daysFromNow === 1
    ? 'Due tomorrow'
    : `Due in ${daysFromNow} days`;

  return (
    <div
      className={cn(
        'mx-6 mt-4 px-4 py-3 rounded-lg border flex items-start gap-3',
        overdue
          ? 'bg-[var(--color-danger)]/10 border-[var(--color-danger)]/30'
          : 'bg-[var(--color-accent-soft)] border-[var(--color-accent)]/30',
      )}
    >
      <div className="flex-shrink-0 mt-0.5">
        {isAI ? (
          <Sparkles className="w-4 h-4 text-[var(--color-accent)]" />
        ) : (
          <BellRing className="w-4 h-4 text-[var(--color-accent)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[12.5px] font-semibold text-[var(--color-text-primary)]">
            Follow up {format(date, 'MMM d')}
          </span>
          <span
            className={cn(
              'mono text-[10.5px] tabular-nums px-1.5 py-0.5 rounded font-medium',
              overdue
                ? 'bg-[var(--color-danger)]/20 text-[var(--color-danger)]'
                : 'bg-[var(--color-accent)]/15 text-[var(--color-accent-fg)]',
            )}
          >
            {dueLabel}
          </span>
          {isAI && (
            <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-accent)]">
              AI{isLowConfidence ? ' · low confidence' : ''}
            </span>
          )}
        </div>
        {followUpReason && (
          <p className="text-[11.5px] text-[var(--color-text-secondary)] mt-1 italic">
            &ldquo;{followUpReason}&rdquo;
          </p>
        )}
        {editing && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="date"
              defaultValue={format(date, 'yyyy-MM-dd')}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const d = new Date(v);
                d.setHours(12, 0, 0, 0);
                onUpdate(conversationId, { followUpAt: d.toISOString(), followUpSource: 'manual' });
                setEditing(false);
              }}
              className="text-[11px] px-2 py-1 rounded border border-[var(--color-hairline)] bg-[var(--color-card)] text-[var(--color-text-primary)]"
            />
            <button
              onClick={() => setEditing(false)}
              className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      <div className="flex-shrink-0 flex items-center gap-1">
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)]"
            title="Change date"
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          >
            <Calendar className="w-3.5 h-3.5" />
          </button>
        )}
        {isAI ? (
          <button
            onClick={async () => {
              // Record feedback + clear in one call so future classify
              // runs avoid re-triggering on similar phrasing.
              try {
                await fetch('/api/follow-ups/dismiss', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ conversationId, phrase: followUpReason, kind: followUpConfidence === 'low' ? 'soft' : 'commitment' }),
                });
              } catch {}
              onUpdate(conversationId, { followUpAt: null, followUpSource: null });
            }}
            className="inline-flex items-center gap-1 px-2 h-7 rounded-md text-[10.5px] font-semibold text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-card-hover)]"
            title="Wrong follow-up — clear and tell AI not to trigger on similar phrasing"
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          >
            <ThumbsDown className="w-3.5 h-3.5" /> Wrong
          </button>
        ) : (
          <button
            onClick={() => onUpdate(conversationId, { followUpAt: null })}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-card-hover)]"
            title="Dismiss follow-up"
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// Date divider — "Today", "Yesterday", or "Mar 4, 2026". Hairline on either
// side with a centered pill. Refined, minimal, doesn't shout.
function DateDivider({ date }: { date: Date }) {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const sameYear = date.getFullYear() === now.getFullYear();
  const label = isToday
    ? 'Today'
    : isYesterday
      ? 'Yesterday'
      : format(date, sameYear ? 'EEE, MMM d' : 'MMM d, yyyy');
  return (
    <div className="flex items-center gap-3 my-5" aria-label={label}>
      <div className="flex-1 h-px bg-[var(--color-hairline)]" />
      <span className="eyebrow text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)]">
        {label}
      </span>
      <div className="flex-1 h-px bg-[var(--color-hairline)]" />
    </div>
  );
}

function MessageBubble({
  message,
  isLast,
  otherAvatarUrl,
}: {
  message: Message;
  isLast: boolean;
  otherAvatarUrl?: string;
}) {
  const isMe = message.isFromMe;
  return (
    <div className={cn('row-in flex gap-3 mb-4', isMe && 'flex-row-reverse')}>
      {!isMe && (
        <Avatar
          name={message.senderName}
          src={otherAvatarUrl}
          size="sm"
          className="mt-1 flex-shrink-0"
        />
      )}
      <div className={cn('max-w-[70%] flex flex-col gap-1', isMe && 'items-end')}>
        {!isMe && (
          <span className="text-[11px] font-medium text-[var(--color-text-tertiary)] px-1">{message.senderName}</span>
        )}
        <div
          className={cn(
            'px-4 py-3 rounded-2xl text-[13.5px] leading-relaxed whitespace-pre-wrap break-words',
            isMe
              ? 'bg-[var(--color-bubble-own)] text-[var(--color-bubble-own-fg)] rounded-br-sm'
              : 'bg-[var(--color-bubble-them)] text-[var(--color-text-primary)] rounded-bl-sm',
          )}
        >
          {message.body}
        </div>
        <span className="mono text-[10px] text-[var(--color-text-tertiary)] px-1">
          {format(new Date(message.sentAt), 'h:mm a')}
        </span>
      </div>
    </div>
  );
}

function SnoozeModal({
  onClose,
  onSnooze,
  onUnsnooze,
  isSnoozed,
}: {
  onClose: () => void;
  onSnooze: (until: Date) => void;
  onUnsnooze: () => void;
  isSnoozed: boolean;
}) {
  const options = [
    { label: 'In 1 hour', fn: () => new Date(Date.now() + 60 * 60 * 1000) },
    { label: 'Tomorrow morning', fn: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
    { label: 'Next week', fn: () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return d; } },
    { label: 'In 2 weeks', fn: () => { const d = new Date(); d.setDate(d.getDate() + 14); d.setHours(9, 0, 0, 0); return d; } },
  ];
  return (
    <div
      className="menu-in absolute top-12 right-0 z-50 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl w-52 py-1 overflow-hidden"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <p className="eyebrow px-4 py-2">{isSnoozed ? 'Snoozed' : 'Snooze until'}</p>
      {isSnoozed && (
        <>
          <button
            onClick={() => { onUnsnooze(); onClose(); }}
            className="w-full text-left px-4 py-2 text-[13px] hover:bg-[var(--color-card-hover)] text-[var(--color-accent)] font-medium"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            Unsnooze now
          </button>
          <div className="border-t border-[var(--color-hairline)] my-1" />
        </>
      )}
      {options.map((o) => (
        <button
          key={o.label}
          onClick={() => { onSnooze(o.fn()); onClose(); }}
          className="w-full text-left px-4 py-2 text-[13px] hover:bg-[var(--color-card-hover)] text-[var(--color-text-primary)]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          {isSnoozed ? `Re-snooze: ${o.label.toLowerCase()}` : o.label}
        </button>
      ))}
    </div>
  );
}

function FollowUpModal({
  hasFollowUp,
  onClose,
  onSet,
  onClear,
}: {
  hasFollowUp: boolean;
  onClose: () => void;
  onSet: (at: Date) => void;
  onClear: () => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const options = [
    { label: 'In 1 day', fn: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
    { label: 'In 3 days', fn: () => { const d = new Date(); d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0); return d; } },
    { label: 'In 1 week', fn: () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return d; } },
    { label: 'In 2 weeks', fn: () => { const d = new Date(); d.setDate(d.getDate() + 14); d.setHours(9, 0, 0, 0); return d; } },
  ];

  function applyCustom() {
    if (!customDate) return;
    const d = new Date(customDate);
    if (isNaN(d.getTime())) return;
    onSet(d);
    onClose();
  }

  return (
    <div
      className="menu-in absolute top-12 right-0 z-50 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl w-60 py-1 overflow-hidden"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <p className="eyebrow px-4 py-2">Follow up</p>
      {options.map((o) => (
        <button
          key={o.label}
          onClick={() => { onSet(o.fn()); onClose(); }}
          className="w-full text-left px-4 py-2 text-[13px] hover:bg-[var(--color-card-hover)] text-[var(--color-text-primary)]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          {o.label}
        </button>
      ))}
      <div className="border-t border-[var(--color-hairline)] my-1" />
      {!showCustom ? (
        <button
          onClick={() => setShowCustom(true)}
          className="w-full text-left px-4 py-2 text-[13px] hover:bg-[var(--color-card-hover)] text-[var(--color-text-primary)]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          Custom date…
        </button>
      ) : (
        <div className="px-3 py-2 flex flex-col gap-2">
          <input
            type="datetime-local"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            className="bg-[var(--color-surface)] text-[var(--color-text-primary)] text-[13px] rounded-md px-2 py-1.5 outline-none border border-[var(--color-hairline)] focus:border-[var(--color-accent)]"
            style={{ transition: 'border-color 140ms var(--ease-out-quart)' }}
          />
          <div className="flex gap-1.5 justify-end">
            <button
              onClick={() => { setShowCustom(false); setCustomDate(''); }}
              className="px-2.5 py-1 text-[11px] text-[var(--color-text-tertiary)] rounded hover:bg-[var(--color-card-hover)]"
              style={{ transition: 'all 140ms var(--ease-out-quart)' }}
            >
              Cancel
            </button>
            <button
              onClick={applyCustom}
              disabled={!customDate}
              className={cn(
                'px-2.5 py-1 text-[11px] rounded font-medium',
                customDate
                  ? 'bg-[var(--color-accent-deep)] text-white hover:bg-[var(--color-accent)]'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] cursor-not-allowed',
              )}
              style={{ transition: 'all 140ms var(--ease-out-quart)' }}
            >
              Set
            </button>
          </div>
        </div>
      )}
      {hasFollowUp && (
        <>
          <div className="border-t border-[var(--color-hairline)] my-1" />
          <button
            onClick={() => { onClear(); onClose(); }}
            className="w-full text-left px-4 py-2 text-[13px] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            Clear follow-up
          </button>
        </>
      )}
      <div className="border-t border-[var(--color-hairline)] my-1" />
      <button
        onClick={onClose}
        className="w-full text-left px-4 py-2 text-[13px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-card-hover)]"
        style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
      >
        Cancel
      </button>
    </div>
  );
}

function NotesPanel({ conversationId, initialNotes }: { conversationId: string; initialNotes: string }) {
  const { updateConversation } = useStore();
  const [open, setOpen] = useState(initialNotes.trim().length > 0);
  const [value, setValue] = useState(initialNotes);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(initialNotes);

  // Re-sync if conversation switched
  useEffect(() => {
    setValue(initialNotes);
    lastSavedRef.current = initialNotes;
    setOpen(initialNotes.trim().length > 0);
    setSavedAt(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, [conversationId, initialNotes]);

  function save(next: string) {
    if (next === lastSavedRef.current) return;
    lastSavedRef.current = next;
    updateConversation(conversationId, { notes: next });
    setSavedAt(Date.now());
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setValue(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(next), 800);
  }

  function onBlur() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    save(value);
  }

  const hasContent = value.trim().length > 0;

  return (
    <div className="border-b border-[var(--color-hairline)] flex-shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-6 py-2 text-[11px] font-semibold text-[var(--color-text-tertiary)] hover:bg-[var(--color-card-hover)] hover:text-[var(--color-text-secondary)]"
        style={{ transition: 'all 140ms var(--ease-out-quart)' }}
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <StickyNote className="w-3.5 h-3.5" />
        <span className="uppercase tracking-wider">Notes</span>
        {hasContent && !open && (
          <span className="ml-1 text-[var(--color-text-tertiary)] truncate normal-case font-normal tracking-normal max-w-[28rem]">
            — {value.replace(/\s+/g, ' ').slice(0, 80)}{value.length > 80 ? '…' : ''}
          </span>
        )}
        {savedAt && open && (
          <span className="ml-auto eyebrow text-[10px]">Saved</span>
        )}
      </button>
      {open && (
        <div className="px-6 pb-3">
          <textarea
            value={value}
            onChange={onChange}
            onBlur={onBlur}
            placeholder="Add private notes for this conversation… (auto-saves)"
            rows={4}
            className="w-full bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-lg px-3 py-2 text-[13px] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] resize-y outline-none focus:border-[var(--color-accent)]"
            style={{ transition: 'border-color 140ms var(--ease-out-quart)' }}
          />
        </div>
      )}
    </div>
  );
}

function LabelPicker({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const { labels, updateConversation, conversations } = useStore();
  const convo = conversations.find((c) => c.id === conversationId);
  const currentLabels = convo?.labels ?? [];

  function toggle(labelId: string) {
    const updated = currentLabels.includes(labelId)
      ? currentLabels.filter((l) => l !== labelId)
      : [...currentLabels, labelId];
    updateConversation(conversationId, { labels: updated });
  }

  return (
    <div
      className="menu-in absolute top-12 right-0 z-50 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl w-52 py-1 overflow-hidden"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <p className="eyebrow px-4 py-2">Labels</p>
      {labels.map((l) => (
        <button
          key={l.id}
          onClick={() => toggle(l.id)}
          className="w-full flex items-center gap-3 px-4 py-2 text-[13px] hover:bg-[var(--color-card-hover)]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
          <span className="flex-1 text-left text-[var(--color-text-primary)]">{l.name}</span>
          {currentLabels.includes(l.id) && <Check className="w-3.5 h-3.5 text-[var(--color-accent)]" />}
        </button>
      ))}
      <div className="border-t border-[var(--color-hairline)] my-1" />
      <button
        onClick={onClose}
        className="w-full text-left px-4 py-2 text-[13px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-card-hover)]"
        style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
      >
        Done
      </button>
    </div>
  );
}

export function MessageThread() {
  const { activeConversationId, conversations, messages, setMessages, loadMessages, auth, updateConversation, deleteConversation, labels, snippets, setActiveConversationId, setActiveFilter, loadFromServer } = useStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [replyText, setReplyText] = useState('');
  // Draft-mode state — recipient typeahead, channel pick, subject (SN-only).
  // Lives inline in MessageThread so the existing AI Drafts / Improve /
  // Snippets / right-sidebar / etc. all just work.
  type ContactHit = { id: string; name: string; headline: string | null; company: string | null; role: string | null; avatarUrl: string | null; linkedinUrn: string | null; profileSlug: string | null; profileUrl: string | null };
  const [recipientQuery, setRecipientQuery] = useState('');
  const [recipientResults, setRecipientResults] = useState<ContactHit[]>([]);
  const [draftChannel, setDraftChannel] = useState<'linkedin' | 'sn' | null>(null);
  const [sending, setSending] = useState(false);
  const [sentFlash, setSentFlash] = useState(false);
  const [loading] = useState(false);
  const [error] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showSnooze, setShowSnooze] = useState(false);
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [draftsContextUsed, setDraftsContextUsed] = useState<string[]>([]);
  const [draftsExtraContext, setDraftsExtraContext] = useState('');
  const [showDraftsContextInput, setShowDraftsContextInput] = useState(false);
  const [draftsReadiness, setDraftsReadiness] = useState<'thin' | 'some' | 'strong' | null>(null);
  const [showImprove, setShowImprove] = useState(false);
  const [improveLoading, setImproveLoading] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [improveSuggestions, setImproveSuggestions] = useState<string[]>([]);
  const [improveImproved, setImproveImproved] = useState<string | null>(null);
  const [improveBaseline, setImproveBaseline] = useState<{ replyRate: number; sent: number } | null>(null);
  const [composeFocused, setComposeFocused] = useState(false);
  // Briefly flash the textarea when a snippet shortcut auto-expands so the
  // user sees the insertion register.
  const [snippetFlashKey, setSnippetFlashKey] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Debounce typing fires to ~3s — LinkedIn shows the indicator for ~5s after
  // each request, so a 3s heartbeat keeps it visible without spamming.
  const lastTypingAtRef = useRef<number>(0);
  function fireTyping() {
    const now = Date.now();
    if (now - lastTypingAtRef.current < 3_000) return;
    if (!activeConversationId) return;
    // No typing pings for drafts — there's no real LinkedIn conversation
    // yet and the placeholder ID isn't valid for the typing API.
    if (activeConversationId.startsWith('draft:')) return;
    lastTypingAtRef.current = now;
    window.postMessage(
      { type: 'inboxpro-typing', conversationUrn: activeConversationId },
      '*',
    );
  }

  const convo = conversations.find((c) => c.id === activeConversationId);
  const threadMessages = activeConversationId ? (messages[activeConversationId] ?? []) : [];
  const primary = convo?.participants[0];
  const convoLabels = labels.filter((l) => convo?.labels.includes(l.id));
  const isDraft = convo?.status === 'draft';
  // Hydrate draft channel from conversation.source on first render so a
  // previously-chosen channel persists across navigation. SN convs map to
  // 'sn'; everything else defaults to null (user must pick).
  useEffect(() => {
    if (!convo || convo.status !== 'draft') return;
    if (draftChannel !== null) return;
    if (convo.source === 'sales_nav') setDraftChannel('sn');
    else if (convo.source === 'linkedin' && primary) setDraftChannel('linkedin');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convo?.id, convo?.status]);
  // Recipient typeahead — debounced search against /api/contacts/search.
  // Only fires when in draft mode AND no recipient picked yet.
  useEffect(() => {
    if (!isDraft || primary) return;
    const q = recipientQuery.trim();
    if (q.length < 2) { setRecipientResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const ch = draftChannel ?? 'linkedin';
        const r = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}&channel=${ch}`);
        const d = await r.json();
        setRecipientResults(d.contacts ?? []);
      } catch { setRecipientResults([]); }
    }, 200);
    return () => clearTimeout(t);
  }, [isDraft, primary, recipientQuery, draftChannel]);
  // Reset draft-mode state when switching conversations so we don't bleed
  // recipient/channel from one draft into another (or into a real conv).
  // Also clear AI Drafts ad-hoc context — it's per-thread.
  useEffect(() => {
    setRecipientQuery('');
    setRecipientResults([]);
    setDraftChannel(null);
    setDraftsExtraContext('');
    setShowDraftsContextInput(false);
  }, [activeConversationId]);

  // When user picks a recipient from typeahead, first check if they
  // already have an existing thread with this person on the chosen channel.
  // If yes, redirect to the existing thread + discard the empty draft
  // (LinkedIn's own behavior — no duplicate threads).
  async function pickRecipient(c: ContactHit) {
    if (!convo) return;
    const participant = {
      id: c.linkedinUrn ?? '',
      name: c.name,
      headline: c.headline ?? undefined,
      avatarUrl: c.avatarUrl ?? undefined,
      profileUrl: c.profileUrl ?? undefined,
      company: c.company ?? undefined,
    };
    setRecipientQuery('');
    setRecipientResults([]);

    // Existing-thread check — only run if a channel is set. Without channel
    // we can't know which inbox to look in. If user hasn't picked one yet,
    // proceed with normal draft persistence and they can change later.
    if (c.linkedinUrn && draftChannel) {
      const source = draftChannel === 'sn' ? 'sales_nav' : 'linkedin';
      try {
        const r = await fetch(`/api/conversations/find-by-recipient?urn=${encodeURIComponent(c.linkedinUrn)}&source=${source}`);
        const d = await r.json();
        if (d?.conversation?.id) {
          // Redirect to the existing thread, discard the empty draft.
          const draftId = convo.id;
          setActiveConversationId(d.conversation.id);
          setActiveFilter('all');
          requestAnimationFrame(() => { try { deleteConversation(draftId); } catch {} });
          return;
        }
      } catch {
        // Find-by-recipient is best-effort. On failure, proceed with the
        // normal draft path — duplicate detection just doesn't fire.
      }
    }

    updateConversation(convo.id, { participants: [participant] });
  }
  function clearRecipient() {
    if (!convo) return;
    updateConversation(convo.id, { participants: [] });
  }
  async function setChannel(ch: 'linkedin' | 'sn') {
    setDraftChannel(ch);
    if (!convo) return;
    const source = ch === 'sn' ? 'sales_nav' : 'linkedin';
    updateConversation(convo.id, { source });

    // If recipient is already picked and we now know the channel, repeat
    // the existing-thread check — redirect if a thread already exists.
    const urn = primary?.id;
    if (urn) {
      try {
        const r = await fetch(`/api/conversations/find-by-recipient?urn=${encodeURIComponent(urn)}&source=${source}`);
        const d = await r.json();
        if (d?.conversation?.id) {
          const draftId = convo.id;
          setActiveConversationId(d.conversation.id);
          setActiveFilter('all');
          requestAnimationFrame(() => { try { deleteConversation(draftId); } catch {} });
        }
      } catch {}
    }
  }
  function discardDraft() {
    if (!convo) return;
    if (!confirm('Discard this draft? This can\'t be undone.')) return;
    // Order matters: drop active selection FIRST so the right-column
    // doesn't render a half-deleted conv mid-flight. Then delete (which
    // also clears active in the store, but redundant is fine). Filter
    // change comes last so the user lands on Drafts cleanly.
    const id = convo.id;
    setActiveConversationId(null);
    setActiveFilter('drafts');
    // requestAnimationFrame defers the store mutation by one paint so
    // React commits the active=null render before the conversations array
    // mutates. Removes a class of stale-reference crashes.
    requestAnimationFrame(() => {
      try { deleteConversation(id); } catch {}
    });
  }

  // Load messages from the DB whenever the active conversation changes.
  useEffect(() => {
    if (activeConversationId) loadMessages(activeConversationId);
  }, [activeConversationId, loadMessages]);

  // Bridge poll (10s) keeps DB current. No per-thread refresh on open —
  // that was triggering writes that overwrote good participant data.

  // Mark conversation as read when opened (don't wipe messages).
  // Skip drafts — overwriting status='draft' with 'read' would silently
  // promote the draft to a real thread before the user clicks Send.
  //
  // CRITICAL: `conversations` is NOT in deps even though we read from it.
  // updateConversation creates a new array reference on every call, so
  // including it would cause an infinite loop (effect fires → update →
  // new array → effect fires → ...). We read the latest array via a ref.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  useEffect(() => {
    if (!activeConversationId) return;
    const c = conversationsRef.current.find((x) => x.id === activeConversationId);
    if (!c) return;
    if (c.status === 'draft') return;
    // Idempotency guard — skip if already in the target state. Belt-and-
    // suspenders against the same loop class.
    if (c.status === 'read' && (c.unreadCount ?? 0) === 0) return;
    updateConversation(activeConversationId, { status: 'read', unreadCount: 0 });
  }, [activeConversationId, updateConversation]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [threadMessages]);

  async function requestDrafts() {
    if (!activeConversationId) return;
    setShowDrafts(true);
    setDrafts([]);
    setDraftsError(null);
    setDraftsLoading(true);
    try {
      const r = await fetch('/api/ai/draft-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: activeConversationId,
          // Free-form context the user typed into the "Add context" box.
          // Empty string is fine; server treats as absent.
          extraContext: draftsExtraContext.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg: string = err.error ?? `HTTP ${r.status}`;
        setDraftsError(
          msg.startsWith('NO_API_KEY')
            ? 'Set your Anthropic API key in Settings → AI.'
            : msg,
        );
        return;
      }
      const data = await r.json();
      setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
      setDraftsContextUsed(Array.isArray(data.contextUsed) ? data.contextUsed : []);
      setDraftsReadiness(data.readiness ?? null);
    } catch (e) {
      setDraftsError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setDraftsLoading(false);
    }
  }

  function applyDraft(text: string) {
    setReplyText(text);
    setShowDrafts(false);
    textareaRef.current?.focus();
  }

  async function requestImprove() {
    if (!replyText.trim() || !activeConversationId) return;
    setShowImprove(true);
    setImproveLoading(true);
    setImproveError(null);
    setImproveSuggestions([]);
    setImproveImproved(null);
    try {
      const r = await fetch('/api/ai/improve-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: activeConversationId, draft: replyText }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg: string = err.error ?? `HTTP ${r.status}`;
        setImproveError(msg.startsWith('NO_API_KEY') ? 'Add your Anthropic API key in Settings.' : msg);
        return;
      }
      const data = await r.json();
      setImproveSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      setImproveImproved(typeof data.improved === 'string' ? data.improved : null);
      setImproveBaseline(data.baseline ?? null);
    } catch (e) {
      setImproveError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setImproveLoading(false);
    }
  }

  async function handleSend() {
    if (!replyText.trim() || !activeConversationId) return;
    if (!isExtensionReady()) {
      setSendError('InboxPro extension not detected. Reload extension and refresh.');
      return;
    }

    // Draft-mode send: spins up a NEW LinkedIn DM or SN InMail thread via
    // the createNewThread extension action. Different validation, different
    // optimistic-update strategy (delete draft on success, let sync pull
    // the real conversation).
    if (isDraft) {
      if (!primary) { setSendError('Pick a recipient first.'); return; }
      if (!primary.id) { setSendError('Recipient has no LinkedIn URN. Visit their profile once to capture it.'); return; }
      if (!draftChannel) { setSendError('Pick a channel (LinkedIn DM or Sales Nav).'); return; }
      setSending(true);
      setSendError(null);
      const body = replyText.trim();
      const draftId = activeConversationId;
      const requestId = `new-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const onResult = (ev: MessageEvent) => {
        if (ev.source !== window || !ev.data) return;
        if (ev.data.type !== 'inboxpro-new-thread-result' || ev.data.requestId !== requestId) return;
        window.removeEventListener('message', onResult);
        const r = ev.data.response;
        if (r?.ok) {
          (async () => {
            await deleteConversation(draftId);
            await loadFromServer();
            setActiveConversationId(null);
            setActiveFilter('all');
            setSending(false);
            setSentFlash(true);
            setTimeout(() => setSentFlash(false), 1200);
          })();
        } else {
          setSending(false);
          setSendError(r?.reason || 'Send failed.');
        }
      };
      window.addEventListener('message', onResult);
      window.postMessage({
        type: 'inboxpro-new-thread-request',
        requestId,
        channel: draftChannel,
        recipientUrn: primary.id,
        recipientName: primary.name,
        // Subject intentionally omitted — InboxPro targets messaging
        // existing connections, where LinkedIn doesn't require one.
        subject: null,
        body,
      }, '*');
      setTimeout(() => {
        window.removeEventListener('message', onResult);
        setSending((s) => {
          if (s) setSendError('Send timed out. Check the extension.');
          return false;
        });
      }, 30_000);
      return;
    }

    setSending(true);
    setSendError(null);

    const text = replyText.trim();
    const convId = activeConversationId;

    // Optimistic: add to UI immediately
    const optimistic: Message = {
      id: `optimistic-${Date.now()}`,
      conversationId: convId,
      senderId: auth.profileId ?? 'me',
      senderName: auth.profileName ?? 'Me',
      body: text,
      sentAt: new Date().toISOString(),
      isFromMe: true,
    };
    setMessages(convId, [...threadMessages, optimistic]);
    setReplyText('');
    textareaRef.current?.focus();

    // Send via extension bridge → LinkedIn API
    const requestId = `send-${Date.now()}-${Math.random()}`;
    const onResult = (ev: MessageEvent) => {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type !== 'inboxpro-send-result' || ev.data.requestId !== requestId) return;
      window.removeEventListener('message', onResult);
      const r = ev.data.response;
      setSending(false);
      if (r?.ok) {
        // Success — message is on LinkedIn. The next sync will pull the real one.
        setSendError(null);
        // Brief tactile "sent" flash on the button
        setSentFlash(true);
        setTimeout(() => setSentFlash(false), 1200);
      } else {
        setSendError(r?.reason || 'Send failed. The message is still in your thread but did not reach LinkedIn.');
        console.error('[InboxPro send] full response:', r);
      }
    };
    window.addEventListener('message', onResult);
    window.postMessage({
      type: 'inboxpro-send-message',
      conversationUrn: convId,
      body: text,
      requestId,
    }, '*');

    // Safety timeout
    setTimeout(() => {
      window.removeEventListener('message', onResult);
      setSending((s) => {
        if (s) setSendError('Send timed out. Check the extension.');
        return false;
      });
    }, 20_000);
  }

  function flashSnippet() {
    // Bump the key — re-keys the textarea so the snippet-flash class
    // animation re-fires. Cleared by React when animation finishes.
    setSnippetFlashKey((k) => k + 1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
    // Snippet autocomplete
    if (e.key === ' ' || e.key === 'Enter') {
      const text = replyText.trim();
      const snippet = snippets.find((s) => text.endsWith(s.shortcut));
      if (snippet) {
        setReplyText(text.slice(0, -snippet.shortcut.length) + snippet.body);
        flashSnippet();
        e.preventDefault();
      }
    }
  }

  function applySnippet(body: string) {
    setReplyText(body);
    setShowSnippets(false);
    flashSnippet();
    textareaRef.current?.focus();
  }

  if (!activeConversationId || !convo) {
    return (
      <div className="card flex-1 flex flex-col items-center justify-center gap-3">
        <div className="w-12 h-12 rounded-[12px] bg-[var(--color-surface-2)] flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-[var(--color-text-tertiary)]" />
        </div>
        <p className="text-[16px] font-medium text-[var(--color-text-secondary)]">Select a conversation</p>
        <p className="text-[12px] text-[var(--color-text-tertiary)]">
          Or press <kbd className="mono bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] px-1.5 py-0.5 rounded border border-[var(--color-hairline)] text-[10px]">⌘K</kbd> to search
        </p>
      </div>
    );
  }


  return (
    <div className="@container/mt card flex-1 flex flex-col h-full min-w-[320px] relative overflow-hidden">
      {/* Header — wraps action icons to a second row when the thread column
          is narrower than 640px (container query, not viewport). */}
      <div className="px-6 py-4 border-b border-[var(--color-hairline)] flex items-center gap-4 flex-shrink-0 @max-[640px]/mt:flex-wrap">
        {isDraft && !primary ? (
          // Empty-draft state: avoid the awkward "?" monogram. A pencil
          // tile reads as "you're composing" rather than "unknown contact".
          <div className="w-10 h-10 rounded-[10px] flex items-center justify-center flex-shrink-0 bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]">
            <Pencil className="w-4 h-4" />
          </div>
        ) : (
          <div
            className={cn(
              'w-10 h-10 rounded-[10px] overflow-hidden flex items-center justify-center flex-shrink-0',
              primary?.avatarUrl ? 'bg-[var(--color-surface-2)]' : 'monogram-tile',
            )}
            style={primary?.avatarUrl ? undefined : { ['--mono-hue' as string]: hueForName(primary?.name) }}
          >
            {primary?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={primary.avatarUrl} alt={primary?.name ?? ''} className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            ) : (
              <span className="text-[12px] font-semibold">
                {(primary?.name ?? '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase()}
              </span>
            )}
          </div>
        )}
        <div className="flex-1 min-w-0 relative">
          {isDraft && !primary ? (
            // Recipient picker (draft, no recipient yet) — inline in the
            // header so the page layout stays identical to a real conversation.
            <>
              <h3 className="text-[15px] font-semibold tracking-tight text-[var(--color-text-primary)]">New message</h3>
              <input
                type="text"
                value={recipientQuery}
                onChange={(e) => setRecipientQuery(e.target.value)}
                placeholder="Type a name to find a recipient…"
                className="w-full bg-transparent border-0 outline-none text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] placeholder:font-normal font-normal p-0 mt-0.5"
                autoFocus
              />
              {recipientResults.length > 0 && (
                <div className="popover-in absolute top-full left-0 right-0 mt-1.5 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-lg z-40 max-h-[280px] overflow-y-auto" style={{ boxShadow: 'var(--shadow-raised)', transformOrigin: 'top left' }}>
                  {recipientResults.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => pickRecipient(c)}
                      className="w-full text-left px-3 py-2 hover:bg-[var(--color-card-hover)] border-b border-[var(--color-hairline)] last:border-0 flex items-center gap-2.5"
                    >
                      <div className="w-7 h-7 rounded-full bg-[var(--color-accent-soft)] flex items-center justify-center text-[11px] font-semibold text-[var(--color-accent-fg)] flex-shrink-0">{c.name.slice(0, 1)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium text-[var(--color-text-primary)] truncate">{c.name}</div>
                        <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">
                          {c.role ? `${c.role}${c.company ? ` at ${c.company}` : ''}` : (c.headline || '—')}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className={cn('contents', isDraft && 'row-in')}>
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-[15px] font-semibold tracking-tight text-[var(--color-text-primary)] truncate min-w-0">{primary?.name}</h3>
                {isDraft && (
                  <span className="eyebrow text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] flex-shrink-0">Draft</span>
                )}
                {!isDraft && convo.source === 'sales_nav' && (
                  <span className="eyebrow text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] flex-shrink-0">Sales Nav</span>
                )}
                {isDraft && (
                  <button onClick={clearRecipient} className="text-[10.5px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] underline-offset-2 hover:underline">Change</button>
                )}
              </div>
              {primary?.headline && (
                <p className="text-[12px] text-[var(--color-text-tertiary)] truncate">{primary.headline}</p>
              )}
              {convoLabels.length > 0 && (
                <div className="flex gap-1 mt-1 overflow-hidden">
                  {convoLabels.map((l) => <Badge key={l.id} label={l.name} color={l.color} />)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions — slip below the name row at narrow container widths.
            Draft mode strips most actions (no thread to star/snooze/label/
            archive yet) and repurposes Delete as Discard. */}
        <div className="flex items-center gap-0.5 flex-shrink-0 @max-[640px]/mt:w-full @max-[640px]/mt:basis-full @max-[640px]/mt:justify-end @max-[640px]/mt:pl-14 @max-[640px]/mt:-mt-1">
          {primary?.profileUrl && (
            <a
              href={primary.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
              style={{ transition: 'all 160ms var(--ease-out-quart)' }}
              title="View LinkedIn Profile"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          {isDraft ? (
            <button
              onClick={discardDraft}
              className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
              style={{ transition: 'all 160ms var(--ease-out-quart)' }}
              title="Discard draft"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          ) : (
          <>
          <a
            href={`/api/export?format=md&conversationId=${encodeURIComponent(convo.id)}`}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
            style={{ transition: 'all 160ms var(--ease-out-quart)' }}
            title="Export thread as Markdown"
          >
            <Download className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => updateConversation(convo.id, { isStarred: !convo.isStarred })}
            className={cn('inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-[var(--color-surface-2)]',
              convo.isStarred ? 'text-[var(--color-accent-deep)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]')}
            style={{ transition: 'all 160ms var(--ease-out-quart)' }}
            title="Star"
          >
            <Star className={cn('w-3.5 h-3.5', convo.isStarred && 'fill-current')} />
          </button>

          <div className="relative">
            <button
              onClick={() => { setShowSnooze(!showSnooze); setShowLabels(false); setShowFollowUp(false); }}
              className={cn(
                'inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-[var(--color-surface-2)]',
                convo.status === 'snoozed' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]',
              )}
              style={{ transition: 'all 160ms var(--ease-out-quart)' }}
              title={convo.status === 'snoozed' ? 'Snoozed — click to unsnooze' : 'Snooze'}
            >
              <Clock className="w-3.5 h-3.5" />
            </button>
            {showSnooze && (
              <SnoozeModal
                onClose={() => setShowSnooze(false)}
                onSnooze={(until) => updateConversation(convo.id, { status: 'snoozed', snoozedUntil: until.toISOString() })}
                onUnsnooze={() => updateConversation(convo.id, { status: 'read', snoozedUntil: null })}
                isSnoozed={convo.status === 'snoozed'}
              />
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => { setShowFollowUp(!showFollowUp); setShowSnooze(false); setShowLabels(false); }}
              className={cn(
                'inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-[var(--color-surface-2)]',
                convo.followUpAt ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]',
              )}
              style={{ transition: 'all 160ms var(--ease-out-quart)' }}
              title={convo.followUpAt ? `Follow up ${formatDistanceToNowStrict(new Date(convo.followUpAt), { addSuffix: true })}` : 'Set follow-up'}
            >
              <BellRing className="w-3.5 h-3.5" />
            </button>
            {showFollowUp && (
              <FollowUpModal
                hasFollowUp={!!convo.followUpAt}
                onClose={() => setShowFollowUp(false)}
                onSet={(at) => updateConversation(convo.id, { followUpAt: at.toISOString() })}
                onClear={() => updateConversation(convo.id, { followUpAt: null })}
              />
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => { setShowLabels(!showLabels); setShowSnooze(false); setShowFollowUp(false); }}
              className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
              style={{ transition: 'all 160ms var(--ease-out-quart)' }}
              title="Label"
            >
              <Tag className="w-3.5 h-3.5" />
            </button>
            {showLabels && (
              <LabelPicker conversationId={convo.id} onClose={() => setShowLabels(false)} />
            )}
          </div>

          {convo.status === 'archived' ? (
            <button
              onClick={() => updateConversation(convo.id, { status: 'read' })}
              className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-accent)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
              style={{ transition: 'all 160ms var(--ease-out-quart)' }}
              title="Unarchive"
            >
              <ArchiveRestore className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={() => updateConversation(convo.id, { status: 'archived' })}
              className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
              style={{ transition: 'all 160ms var(--ease-out-quart)' }}
              title="Archive"
            >
              <Archive className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
            style={{ transition: 'all 160ms var(--ease-out-quart)' }}
            title="Delete conversation"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          </>
          )}
        </div>
      </div>

      {confirmDelete && (
        <div className="backdrop-in absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm rounded-[var(--radius-card)]">
          <div
            className="modal-in bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-2xl p-6 w-96"
            style={{ boxShadow: 'var(--shadow-raised)' }}
          >
            <h3 className="text-[16px] font-semibold text-[var(--color-text-primary)] mb-2">Delete conversation?</h3>
            <p className="text-[13px] text-[var(--color-text-secondary)] mb-4">
              Removes this conversation from InboxPro <strong className="text-[var(--color-danger)]">and from LinkedIn</strong>. This is permanent.
            </p>
            <p className="text-[11px] text-[var(--color-text-tertiary)] mb-5">
              To keep the conversation on LinkedIn and only remove it locally, turn off &ldquo;Two-way sync&rdquo; in Settings first.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 text-[13px] font-medium text-[var(--color-text-secondary)] rounded-lg hover:bg-[var(--color-card-hover)]"
                style={{ transition: 'all 140ms var(--ease-out-quart)' }}
              >
                Cancel
              </button>
              <button
                onClick={() => { deleteConversation(convo.id); setConfirmDelete(false); }}
                className="px-4 py-2 text-[13px] font-semibold text-white bg-[var(--color-danger)] hover:opacity-90 rounded-lg"
                style={{ transition: 'all 140ms var(--ease-out-quart)' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notes panel — collapsible */}
      <NotesPanel conversationId={convo.id} initialNotes={convo.notes ?? ''} />

      {convo?.followUpAt && (
        <FollowUpBanner
          conversationId={convo.id}
          followUpAt={convo.followUpAt}
          followUpReason={convo.followUpReason}
          followUpSource={convo.followUpSource}
          followUpConfidence={convo.followUpConfidence}
          onUpdate={updateConversation}
        />
      )}

      {/* Messages — keyed by conv id so switching threads triggers a fresh
          fade-in via the `thread-fade` keyframe (defined in globals.css). */}
      <div
        key={activeConversationId ?? 'empty'}
        className="thread-fade flex-1 overflow-y-auto px-6 py-6"
      >
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-4 py-3 rounded-lg mb-4">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span className="text-[13px]">{error}</span>
          </div>
        )}
        {!loading && threadMessages.length === 0 && !error && (
          <div className="text-center py-12 text-[var(--color-text-tertiary)] text-[13px]">No messages loaded yet</div>
        )}
        {threadMessages.map((msg, i) => {
          // Render a date divider when this message's date differs from the
          // previous one. First message always gets one.
          const prev = i > 0 ? threadMessages[i - 1] : null;
          const msgDate = new Date(msg.sentAt);
          const prevDate = prev ? new Date(prev.sentAt) : null;
          const sameDay = prevDate
            && msgDate.getFullYear() === prevDate.getFullYear()
            && msgDate.getMonth() === prevDate.getMonth()
            && msgDate.getDate() === prevDate.getDate();
          return (
            <div key={msg.id}>
              {!sameDay && <DateDivider date={msgDate} />}
              <MessageBubble
                message={msg}
                isLast={i === threadMessages.length - 1}
                otherAvatarUrl={primary?.avatarUrl}
              />
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Reply box */}
      <div className="px-6 py-4 border-t border-[var(--color-hairline)] flex-shrink-0">
        {sendError && (
          <div
            key={sendError}
            className="text-[11px] text-[var(--color-danger)] mb-2 flex items-center gap-1 shake"
          >
            <AlertCircle className="w-3.5 h-3.5" /> {sendError}
          </div>
        )}
        <div
          className="relative bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-xl focus-within:border-[var(--color-accent)]"
          style={{ transition: 'border-color 160ms var(--ease-out-quart)' }}
        >
          {/* Snippet picker */}
          {showSnippets && (
            <div
              className="popover-in absolute bottom-full left-0 mb-2 w-72 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl py-1 z-50 overflow-hidden"
              style={{ boxShadow: 'var(--shadow-raised)', transformOrigin: 'bottom left' }}
            >
              <p className="eyebrow px-4 py-2">Snippets</p>
              {snippets.map((s) => (
                <button
                  key={s.id}
                  onClick={() => applySnippet(s.body)}
                  className="w-full text-left px-4 py-2 hover:bg-[var(--color-card-hover)]"
                  style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
                >
                  <p className="text-[13px] font-medium text-[var(--color-text-primary)]">{s.name}</p>
                  <p className="mono text-[10px] text-[var(--color-text-tertiary)] truncate">{s.shortcut}</p>
                </button>
              ))}
            </div>
          )}

          {/* Improve popover — Claude critiques the current draft */}
          {showImprove && (
            <div
              className="popover-in absolute bottom-full left-0 mb-2 w-[460px] bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl py-1 z-50 overflow-hidden"
              style={{ boxShadow: 'var(--shadow-raised)', transformOrigin: 'bottom left' }}
            >
              <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-hairline)]">
                <span className="eyebrow flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-[var(--color-accent)]" /> AI Improve
                </span>
                <button
                  onClick={() => setShowImprove(false)}
                  className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                  style={{ transition: 'color 140ms var(--ease-out-quart)' }}
                >
                  Close
                </button>
              </div>
              {improveLoading && (
                <div className="px-4 py-6 text-center text-[12px] text-[var(--color-text-tertiary)] flex items-center justify-center gap-2">
                  <div className="w-3.5 h-3.5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
                  Analyzing draft against your reply history…
                </div>
              )}
              {improveError && (
                <div className="px-4 py-3 text-[12px] text-[var(--color-danger)]">{improveError}</div>
              )}
              {improveBaseline && improveBaseline.sent > 0 && !improveLoading && (
                <div className="px-4 py-1.5 text-[10.5px] text-[var(--color-text-tertiary)] bg-[var(--color-surface)] border-b border-[var(--color-hairline)]">
                  Your baseline: <span className="text-[var(--color-text-primary)] font-medium">{(improveBaseline.replyRate * 100).toFixed(0)}% reply rate</span> ({improveBaseline.sent} outbound)
                </div>
              )}
              {improveSuggestions.length > 0 && (
                <div className="px-4 py-3">
                  <div className="eyebrow mb-2">Suggestions</div>
                  <ul className="space-y-1.5">
                    {improveSuggestions.map((s, i) => (
                      <li key={i} className="text-[12.5px] text-[var(--color-text-primary)] leading-relaxed pl-3 relative">
                        <span className="absolute left-0 top-1.5 w-1 h-1 rounded-full bg-[var(--color-accent)]" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {improveImproved && (
                <div className="px-4 py-3 border-t border-[var(--color-hairline)]">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="eyebrow">Improved version</span>
                    <button
                      onClick={() => { setReplyText(improveImproved); setShowImprove(false); textareaRef.current?.focus(); }}
                      className="text-[11px] font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] px-2 py-1 rounded hover:bg-[var(--color-accent-soft)]"
                      style={{ transition: 'all 140ms var(--ease-out-quart)' }}
                    >
                      Use this
                    </button>
                  </div>
                  <p className="text-[12.5px] text-[var(--color-text-primary)] whitespace-pre-wrap leading-relaxed">{improveImproved}</p>
                </div>
              )}
              {!improveLoading && !improveError && improveSuggestions.length === 0 && !improveImproved && (
                <div className="px-4 py-3 text-[12px] text-[var(--color-text-tertiary)]">No suggestions — your draft looks good as-is.</div>
              )}
            </div>
          )}

          {/* Draft picker — popover shows 3 AI-generated drafts */}
          {showDrafts && (
            <div
              className="popover-in absolute bottom-full left-0 mb-2 w-[420px] bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl py-1 z-50 overflow-hidden"
              style={{ boxShadow: 'var(--shadow-raised)', transformOrigin: 'bottom left' }}
            >
              <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-hairline)]">
                <span className="eyebrow flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-[var(--color-accent)]" /> AI Drafts
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowDraftsContextInput((v) => !v)}
                    className={cn(
                      'press-feedback text-[11px] font-semibold inline-flex items-center gap-1 px-2 py-1 rounded-md',
                      showDraftsContextInput
                        ? 'bg-[var(--color-accent)] text-white'
                        : 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] hover:bg-[rgb(var(--color-accent-rgb)/0.22)]',
                    )}
                    style={{ transition: 'all 140ms var(--ease-out-quart)' }}
                    title="Add ad-hoc context for this draft (e.g. 'met in June', 'meeting already booked')"
                  >
                    <Sparkles className="w-3 h-3" />
                    {showDraftsContextInput ? 'Context open' : 'Add context'}
                  </button>
                  <button
                    onClick={() => setShowDrafts(false)}
                    className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                    style={{ transition: 'color 140ms var(--ease-out-quart)' }}
                  >
                    Close
                  </button>
                </div>
              </div>
              {showDraftsContextInput && (
                <div className="px-4 py-2.5 border-b border-[var(--color-hairline)] bg-[var(--color-card-hover)]">
                  <textarea
                    value={draftsExtraContext}
                    onChange={(e) => setDraftsExtraContext(e.target.value)}
                    placeholder="Anything Claude should know for this draft — e.g. &ldquo;we met in June&rdquo;, &ldquo;meeting already booked for Aug 12&rdquo;, &ldquo;they asked for a follow-up after RSA&rdquo;…"
                    rows={3}
                    className="input w-full resize-y text-[12px]"
                  />
                  <div className="flex items-center justify-between mt-1.5">
                    <p className="text-[10.5px] text-[var(--color-text-tertiary)]">Persists only for this draft request. Cleared on next thread.</p>
                    <button
                      onClick={() => { setShowDrafts(false); requestDrafts(); }}
                      className="text-[11px] font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] px-2 py-1 rounded hover:bg-[var(--color-accent-soft)]"
                      style={{ transition: 'all 140ms var(--ease-out-quart)' }}
                    >
                      Re-draft with context →
                    </button>
                  </div>
                </div>
              )}
              {!draftsLoading && !draftsError && drafts.length > 0 && draftsContextUsed.length > 0 && (
                <div className={cn(
                  'px-4 py-1.5 text-[10.5px] border-b border-[var(--color-hairline)] flex items-start gap-1.5',
                  draftsReadiness === 'thin'
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-text-tertiary)]',
                )}>
                  <span className="font-medium uppercase tracking-wide whitespace-nowrap">{draftsReadiness === 'thin' ? 'Thin context' : 'Used'}:</span>
                  <span className="flex-1">{draftsContextUsed.join(', ')}{draftsReadiness === 'thin' ? ' — try Refresh profile for richer drafts' : ''}</span>
                </div>
              )}
              {draftsLoading && (
                <div className="px-4 py-6 text-center text-[12px] text-[var(--color-text-tertiary)] flex items-center justify-center gap-2">
                  <div className="w-3.5 h-3.5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
                  Generating drafts…
                </div>
              )}
              {draftsError && (
                <div className="px-4 py-3 text-[12px] text-[var(--color-danger)]">{draftsError}</div>
              )}
              {!draftsLoading && !draftsError && drafts.length === 0 && (
                <div className="px-4 py-4 text-[12px] text-[var(--color-text-tertiary)]">No drafts returned.</div>
              )}
              <div className="row-in-stagger">
              {drafts.map((d, i) => (
                <button
                  key={i}
                  onClick={() => applyDraft(d)}
                  className="block w-full text-left px-4 py-2.5 hover:bg-[var(--color-card-hover)] border-b border-[var(--color-hairline)] last:border-0"
                  style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
                >
                  <div className="eyebrow mb-1">Draft {i + 1}</div>
                  <p className="text-[12.5px] text-[var(--color-text-primary)] whitespace-pre-wrap leading-relaxed">{d}</p>
                </button>
              ))}
              </div>
              {!draftsLoading && drafts.length > 0 && (
                <div className="px-4 py-2 text-[10.5px] text-[var(--color-text-tertiary)] border-t border-[var(--color-hairline)]">
                  Click a draft to insert it into the composer. Edit before sending.
                </div>
              )}
            </div>
          )}

          {/* Draft-mode channel picker — slim row above the textarea. No
              subject field: InboxPro targets messaging existing connections,
              where LinkedIn doesn't require one and SN treats it as a
              regular DM under the hood. */}
          {isDraft && (
            <div className="row-in px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap border-b border-[var(--color-hairline)]">
              <span className="eyebrow mr-1">Via</span>
              <button
                onClick={() => setChannel('linkedin')}
                className={cn(
                  'text-[11.5px] font-semibold px-2.5 py-1 rounded-md inline-flex items-center gap-1.5',
                  draftChannel === 'linkedin'
                    ? 'bg-[#0A66C2] text-white'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
                )}
                style={{ transition: 'all 140ms var(--ease-out-quart)' }}
              >
                LinkedIn DM
              </button>
              <button
                onClick={() => setChannel('sn')}
                className={cn(
                  'text-[11.5px] font-semibold px-2.5 py-1 rounded-md inline-flex items-center gap-1.5',
                  draftChannel === 'sn'
                    ? 'bg-[#0A66C2] text-white'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
                )}
                style={{ transition: 'all 140ms var(--ease-out-quart)' }}
              >
                Sales Nav
              </button>
              {!draftChannel && (
                <span className="text-[11px] text-[var(--color-text-tertiary)]">Pick a channel to enable send</span>
              )}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={replyText}
            onChange={(e) => { setReplyText(e.target.value); fireTyping(); }}
            onKeyDown={handleKeyDown}
            onFocus={() => setComposeFocused(true)}
            onBlur={() => setComposeFocused(false)}
            placeholder={isDraft ? 'Compose your opener… (⌘↵ to send)' : 'Write a message…  (⌘↵ to send, type /snippet shortcut)'}
            key={snippetFlashKey}
            className={cn(
              'w-full bg-transparent px-4 pt-3 pb-2 text-[13.5px] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] resize-none outline-none rounded-lg',
              snippetFlashKey > 0 && 'snippet-flash',
            )}
            style={{
              // Grow on focus, settle on blur — smoother than swapping rows.
              minHeight: isDraft ? 140 : (composeFocused ? 96 : 64),
              transition: 'min-height var(--dur-medium) var(--ease-out-fluid), box-shadow var(--dur-fast) var(--ease-out-soft)',
            }}
          />
          <div className="flex items-center justify-between px-3 pb-2.5">
            <div className="flex items-center gap-1">
              <button
                onClick={requestDrafts}
                disabled={draftsLoading}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ transition: 'background-color 140ms var(--ease-out-quart), color 140ms var(--ease-out-quart)' }}
              >
                <Sparkles className="w-3 h-3 text-[var(--color-accent)]" />
                {draftsLoading ? 'Drafting…' : 'Draft'}
              </button>
              <button
                onClick={requestImprove}
                disabled={improveLoading || !replyText.trim()}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ transition: 'background-color 140ms var(--ease-out-quart), color 140ms var(--ease-out-quart)' }}
                title="Have Claude critique your draft against your reply-rate history"
              >
                <Sparkles className="w-3 h-3 text-[var(--color-accent)]" />
                {improveLoading ? 'Reviewing…' : 'Improve'}
              </button>
              <button
                onClick={() => setShowSnippets(!showSnippets)}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)]"
                style={{ transition: 'background-color 140ms var(--ease-out-quart), color 140ms var(--ease-out-quart)' }}
              >
                <kbd className="kbd">/</kbd>
                Snippets
              </button>
            </div>
            <button
              onClick={handleSend}
              disabled={
                !replyText.trim() || sending || sentFlash ||
                // Draft-mode extra gates — must have recipient + channel.
                (isDraft && (!primary || !draftChannel))
              }
              className={cn(
                'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12px] font-semibold',
                sentFlash && 'send-fly',
                sentFlash
                  ? 'bg-[var(--color-success)] text-white'
                  : replyText.trim() && !sending && (!isDraft || (primary && draftChannel))
                    ? 'bg-[var(--color-accent-deep)] text-white hover:bg-[var(--color-accent)] active:scale-[0.97] active:shadow-inner'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] cursor-not-allowed',
              )}
              style={{
                transition: 'background-color 140ms var(--ease-out-quart), transform 80ms var(--ease-out-quart), box-shadow 80ms var(--ease-out-quart)',
              }}
            >
              {sentFlash ? (
                <Check className="w-3.5 h-3.5" strokeWidth={3} />
              ) : sending ? (
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              {sentFlash ? 'Sent' : sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
        <p className="mono text-[10px] text-[var(--color-text-tertiary)] mt-1.5 text-right">⌘↵ to send</p>
      </div>
    </div>
  );
}
