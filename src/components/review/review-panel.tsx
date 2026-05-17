'use client';
import { useEffect, useMemo, useState } from 'react';
import { HelpCircle, RefreshCw, X, ChevronDown, ChevronRight, Sparkles, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import type { Conversation, Label, Message } from '@/types';
import { format } from 'date-fns';

export function ReviewPanel() {
  const conversations = useStore((s) => s.conversations);
  const labels = useStore((s) => s.labels);
  const updateConversation = useStore((s) => s.updateConversation);
  const loadFromServer = useStore((s) => s.loadFromServer);
  const [refreshing, setRefreshing] = useState(false);

  const toReview = useMemo(
    () => conversations.filter((c) => c.needsReview === true),
    [conversations],
  );

  // Group AI labels by exclusiveGroup so we can render mutex-aware chip rows
  const aiLabels = useMemo(() => labels.filter((l) => l.aiManaged), [labels]);
  const labelGroups = useMemo(() => {
    const groups: Record<string, Label[]> = {};
    const ungrouped: Label[] = [];
    for (const l of aiLabels) {
      if (l.exclusiveGroup) {
        (groups[l.exclusiveGroup] ??= []).push(l);
      } else {
        ungrouped.push(l);
      }
    }
    return { groups, ungrouped };
  }, [aiLabels]);

  function toggleLabel(conv: Conversation, label: Label) {
    const has = conv.labels.includes(label.id);
    let next: string[];
    if (has) {
      // Remove
      next = conv.labels.filter((id) => id !== label.id);
    } else {
      // Add — respect mutex group: remove any existing sibling from same group first
      next = conv.labels.slice();
      if (label.exclusiveGroup) {
        const groupSiblings = aiLabels
          .filter((l) => l.exclusiveGroup === label.exclusiveGroup)
          .map((l) => l.id);
        next = next.filter((id) => !groupSiblings.includes(id));
      }
      next.push(label.id);
    }
    // Preserve needsReview=true so the row stays in the queue until user
    // explicitly hits Done or None apply.
    updateConversation(conv.id, { labels: next, needsReview: true });
  }

  function commitDone(conv: Conversation) {
    updateConversation(conv.id, { needsReview: false });
  }

  function noneApply(conv: Conversation) {
    updateConversation(conv.id, { needsReview: false });
  }

  async function refresh() {
    setRefreshing(true);
    await loadFromServer();
    setRefreshing(false);
  }

  return (
    <div className="card flex-1 overflow-y-auto p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[var(--color-accent-soft)] flex items-center justify-center">
            <HelpCircle className="w-4 h-4 text-[var(--color-accent-deep)]" strokeWidth={2.25} />
          </div>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">Review</h1>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          style={{ transition: 'all 180ms var(--ease-out-quart)' }}
          title="Reload"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      <p className="text-[12px] text-[var(--color-text-tertiary)] mb-5">
        Conversations the AI couldn&apos;t classify confidently. Tap chips to toggle labels on/off (mutex groups still apply), then click <strong>Done</strong> to dismiss. If nothing fits, click <strong>None apply</strong> — not every conversation needs to be labeled.
      </p>

      {toReview.length === 0 ? (
        <div className="card p-8 text-center">
          <HelpCircle className="w-6 h-6 text-[var(--color-text-tertiary)] mx-auto mb-3" />
          <p className="text-[14px] font-medium text-[var(--color-text-secondary)] mb-1">Nothing to review.</p>
          <p className="text-[11.5px] text-[var(--color-text-tertiary)] max-w-md mx-auto">
            Whenever AI classification runs and hits an ambiguous case, it&apos;ll surface here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {toReview.map((conv) => (
            <ReviewRow
              key={conv.id}
              conv={conv}
              labelGroups={labelGroups}
              onToggle={(l) => toggleLabel(conv, l)}
              onDone={() => commitDone(conv)}
              onNoneApply={() => noneApply(conv)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewRow({
  conv,
  labelGroups,
  onToggle,
  onDone,
  onNoneApply,
}: {
  conv: Conversation;
  labelGroups: { groups: Record<string, Label[]>; ungrouped: Label[] };
  onToggle: (label: Label) => void;
  onDone: () => void;
  onNoneApply: () => void;
}) {
  const primary = conv.participants[0];
  const company = (conv.enrichment as { company?: string } | null | undefined)?.company;
  const existingIds = new Set(conv.labels);
  const groupKeys = Object.keys(labelGroups.groups);
  const [expanded, setExpanded] = useState(false);
  const cachedMessages = useStore((s) => s.messages[conv.id]);
  const loadMessages = useStore((s) => s.loadMessages);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded || cachedMessages) return;
    setLoading(true);
    loadMessages(conv.id).finally(() => setLoading(false));
  }, [expanded, cachedMessages, conv.id, loadMessages]);

  return (
    <div className="card p-4">
      {/* Header: avatar + name + company */}
      <div className="flex items-start gap-3 mb-3">
        <AvatarSquare name={primary?.name ?? '?'} src={primary?.avatarUrl ?? null} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold text-[var(--color-text-primary)] truncate">
              {primary?.name ?? 'Unknown'}
            </span>
            {company && (
              <span className="text-[11.5px] text-[var(--color-text-tertiary)] truncate">· {company}</span>
            )}
          </div>
          {conv.aiSummary && (
            <p className="text-[12.5px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">
              {conv.aiSummary}
            </p>
          )}
        </div>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="inline-flex items-center gap-1 text-[11.5px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded-md hover:bg-[var(--color-card-hover)]"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          title={expanded ? 'Hide messages' : 'Show messages'}
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <MessageSquare className="w-3 h-3" />
        </button>
      </div>

      {/* AI summary already shown above; reviewReason isn't stored in the client today.
          Existing labels on the conversation render as a small reminder. */}
      {conv.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)] mr-1 mt-0.5">
            Already applied:
          </span>
          {conv.labels.map((id) => {
            const l = [...labelGroups.ungrouped, ...Object.values(labelGroups.groups).flat()].find((x) => x.id === id);
            if (!l) return null;
            return (
              <span
                key={id}
                className="text-[10.5px] px-1.5 py-0.5 rounded font-medium"
                style={{ background: `${l.color}22`, color: l.color }}
              >
                {l.name}
              </span>
            );
          })}
        </div>
      )}

      {/* Inline messages — expand to read context without leaving the card */}
      {expanded && (
        <div className="mb-3 border border-[var(--color-hairline)] rounded-lg bg-[var(--color-surface-2)] max-h-[280px] overflow-y-auto">
          {loading && !cachedMessages ? (
            <div className="flex flex-col gap-1.5 p-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="skeleton" style={{ height: 40 }} />
              ))}
            </div>
          ) : !cachedMessages || cachedMessages.length === 0 ? (
            <p className="text-[11.5px] text-[var(--color-text-tertiary)] text-center py-4">No messages.</p>
          ) : (
            <div className="divide-y divide-[var(--color-hairline)]">
              {cachedMessages.map((m) => (
                <MessageRow key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Label picker — grouped chips */}
      <div className="space-y-2">
        {groupKeys.map((groupKey) => (
          <div key={groupKey} className="flex flex-wrap items-center gap-1.5">
            <span className="text-[9.5px] uppercase tracking-wide text-[var(--color-text-tertiary)] mr-1 mono">
              {groupKey}
            </span>
            {labelGroups.groups[groupKey].map((l) => (
              <ChipButton
                key={l.id}
                label={l}
                active={existingIds.has(l.id)}
                onClick={() => onToggle(l)}
              />
            ))}
          </div>
        ))}
        {labelGroups.ungrouped.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[9.5px] uppercase tracking-wide text-[var(--color-text-tertiary)] mr-1 mono">
              other
            </span>
            {labelGroups.ungrouped.map((l) => (
              <ChipButton
                key={l.id}
                label={l}
                active={existingIds.has(l.id)}
                onClick={() => onToggle(l)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Commit controls — Done confirms whatever was applied; None apply leaves unlabeled */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          onClick={onNoneApply}
          className="inline-flex items-center gap-1 text-[11.5px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded-md hover:bg-[var(--color-card-hover)]"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          title="None of these labels fit this conversation"
        >
          <X className="w-3 h-3" /> None apply
        </button>
        <button
          onClick={onDone}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          title={conv.labels.length > 0 ? `Confirm ${conv.labels.length} label${conv.labels.length === 1 ? '' : 's'} and dismiss` : 'Mark as reviewed'}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function ChipButton({ label, active, onClick }: { label: Label; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-medium border',
        active
          ? 'border-transparent text-white'
          : 'border-[var(--color-hairline)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]',
      )}
      style={{
        background: active ? label.color : undefined,
        transition: 'all 140ms var(--ease-out-quart)',
      }}
      title={label.description ?? undefined}
    >
      {!active && <span className="w-2 h-2 rounded-full inline-block" style={{ background: label.color }} />}
      {label.name}
    </button>
  );
}

function MessageRow({ message }: { message: Message }) {
  const sentAt = message.sentAt ? new Date(message.sentAt) : null;
  const when = sentAt && !isNaN(sentAt.getTime()) ? format(sentAt, 'MMM d, h:mm a') : '';
  return (
    <div className={cn(
      'px-3 py-2 text-[12px]',
      message.isFromMe ? 'bg-[var(--color-accent-soft)]/40' : '',
    )}>
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className={cn(
          'font-medium text-[11px]',
          message.isFromMe ? 'text-[var(--color-accent-fg)]' : 'text-[var(--color-text-primary)]',
        )}>
          {message.isFromMe ? 'You' : (message.senderName || 'Them')}
        </span>
        {when && <span className="text-[10px] text-[var(--color-text-tertiary)]">{when}</span>}
      </div>
      <p className="text-[12px] text-[var(--color-text-secondary)] leading-relaxed whitespace-pre-wrap break-words">
        {message.body}
      </p>
    </div>
  );
}

function AvatarSquare({ name, src }: { name: string; src: string | null }) {
  return (
    <div className="w-9 h-9 rounded-[10px] overflow-hidden bg-[var(--color-surface-2)] flex items-center justify-center flex-shrink-0">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="w-full h-full object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
          {name.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '·'}
        </span>
      )}
    </div>
  );
}

// Avoid unused-import lint warnings on the few icons we may not use yet
void Sparkles;
