'use client';
import { useEffect, useRef, useState } from 'react';
import { Star, Clock, Archive, Check, StickyNote, BellRing, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/shared/badge';
import { useStore } from '@/store';
import type { AiCategory, Conversation } from '@/types';
import { formatDistanceToNowStrict } from 'date-fns';
import { ConvContextMenu } from './conv-context-menu';
import { hueForName } from '@/lib/color-for-name';

const CATEGORY_STYLE: Record<AiCategory, { label: string; cls: string }> = {
  'cold-pitch': { label: 'Cold',     cls: 'bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)]' },
  'warm-lead':  { label: 'Warm',     cls: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]' },
  'client':     { label: 'Client',   cls: 'bg-[var(--color-success)]/15 text-[var(--color-success)]' },
  'recruiter':  { label: 'Recruit',  cls: 'bg-[var(--color-info)]/15 text-[var(--color-info)]' },
  'intro':      { label: 'Intro',    cls: 'bg-[var(--color-info)]/15 text-[var(--color-info)]' },
  'spam':       { label: 'Spam',     cls: 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]' },
  'other':      { label: '',         cls: '' },
};

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onClick: () => void;
}

function monogram(name: string | undefined): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]?.[0]?.toUpperCase() ?? '·';
  return `${parts[0][0] ?? ''}${parts[parts.length - 1][0] ?? ''}`.toUpperCase();
}

function compactTime(d: Date): string {
  const s = formatDistanceToNowStrict(d, { addSuffix: false });
  return s
    .replace(' seconds', 's').replace(' second', 's')
    .replace(' minutes', ' min').replace(' minute', ' min')
    .replace(' hours', ' h').replace(' hour', ' h')
    .replace(' days', 'd').replace(' day', 'd')
    .replace(' months', 'mo').replace(' month', 'mo')
    .replace(' years', 'y').replace(' year', 'y');
}

export function ConversationItem({ conversation, isActive, onClick }: ConversationItemProps) {
  const { updateConversation, labels, selectedIds, toggleSelected } = useStore();
  const primary = conversation.participants[0];
  const isUnread = conversation.status === 'unread';
  const isSelected = selectedIds.has(conversation.id);
  const anySelected = selectedIds.size > 0;
  const rowRef = useRef<HTMLDivElement>(null);

  // Smoothly scroll into view when this row becomes active. `block: 'nearest'`
  // is a no-op if the row is already visible — only fires when offscreen.
  useEffect(() => {
    if (isActive) {
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isActive]);

  const conversationLabels = labels.filter((l) => conversation.labels.includes(l.id));
  const hasNotes = !!conversation.notes && conversation.notes.trim().length > 0;
  const followUpAt = conversation.followUpAt ? new Date(conversation.followUpAt) : null;
  const followUpOverdue = !!followUpAt && followUpAt.getTime() < Date.now();
  const shortTime = compactTime(new Date(conversation.lastMessageAt));

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
    toggleSelected(conversation.id);
  }
  function handleStar(e: React.MouseEvent) {
    e.stopPropagation();
    updateConversation(conversation.id, { isStarred: !conversation.isStarred });
  }
  function handleSnooze(e: React.MouseEvent) {
    e.stopPropagation();
    const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    updateConversation(conversation.id, { status: 'snoozed', snoozedUntil });
  }
  function handleArchive(e: React.MouseEvent) {
    e.stopPropagation();
    updateConversation(conversation.id, { status: 'archived' });
  }

  function activate() {
    if (anySelected) toggleSelected(conversation.id);
    else onClick();
  }

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={activate}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      className={cn(
        'group/row relative w-full flex items-start gap-3 px-3 py-3 text-left rounded-[12px] cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]',
        isActive && 'bg-[rgb(var(--color-accent-rgb)/0.10)]',
        isSelected && !isActive && 'bg-[rgb(var(--color-accent-rgb)/0.06)]',
        !isActive && !isSelected && 'hover:bg-[var(--color-card-hover)]',
      )}
      style={{
        transition: 'background-color 180ms var(--ease-out-quart)',
        // Skip rendering offscreen rows entirely. 80px is the approximate row
        // height — reserves scroll space so the scrollbar position is stable.
        contentVisibility: 'auto',
        containIntrinsicSize: '80px',
      }}
    >
      {/* Left edge accent bar — solid on active, soft preview on hover */}
      {isActive ? (
        <span
          aria-hidden
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-[var(--color-accent)]"
          style={{ animation: 'row-in 240ms var(--ease-out-quart)' }}
        />
      ) : (
        <span
          aria-hidden
          className="absolute left-0 top-3 bottom-3 w-[2px] rounded-full bg-[var(--color-accent)] opacity-0 group-hover/row:opacity-30"
          style={{ transition: 'opacity 160ms var(--ease-out-quart)' }}
        />
      )}
      {/* Unread dot — small accent indicator far-left, near the avatar */}
      {isUnread && !isActive && (
        <span
          aria-hidden
          className="absolute left-[6px] top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]"
        />
      )}
      {/* Avatar / monogram tile — rounded square */}
      <div className="relative flex-shrink-0">
        {primary?.avatarUrl ? (
          <div
            className={cn(
              'w-11 h-11 overflow-hidden rounded-[10px] bg-[var(--color-surface-2)]',
              // Active row gets a 2px accent outline with 2px offset; inactive gets a hairline border.
              isActive
                ? 'border-2 border-[var(--color-accent)]'
                : 'border border-[var(--color-hairline)]',
              (anySelected || isSelected) && 'opacity-0',
            )}
            style={{ transition: 'opacity 180ms var(--ease-out-quart)' }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={primary.avatarUrl}
              alt={primary?.name ?? ''}
              className="w-full h-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        ) : (
          <div
            className={cn(
              'monogram-tile w-11 h-11 rounded-[10px] flex items-center justify-center',
              isActive
                ? 'border-2 border-[var(--color-accent)]'
                : 'border border-[var(--color-hairline)]',
              (anySelected || isSelected) && 'opacity-0',
            )}
            style={{
              transition: 'opacity 180ms var(--ease-out-quart)',
              ['--mono-hue' as string]: hueForName(primary?.name),
            }}
          >
            <span className="text-[12px] font-semibold tracking-wide">
              {monogram(primary?.name)}
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={handleCheckboxClick}
          aria-label={isSelected ? 'Deselect' : 'Select'}
          aria-pressed={isSelected}
          className={cn(
            'absolute inset-0 flex items-center justify-center rounded-[10px] border',
            isSelected
              ? 'bg-[var(--color-accent-deep)] border-[var(--color-accent-deep)] opacity-100'
              : 'bg-[var(--color-card)] border-[var(--color-rule)] opacity-0 group-hover/row:opacity-100',
            anySelected && !isSelected && 'opacity-100',
          )}
          style={{ transition: 'background-color 140ms var(--ease-out-quart), border-color 140ms var(--ease-out-quart), opacity 140ms var(--ease-out-quart)' }}
        >
          {isSelected && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pr-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex items-baseline gap-1.5">
            <span
              className={cn(
                'truncate text-[13.5px] leading-tight tracking-tight',
                isUnread
                  ? 'font-semibold text-[var(--color-text-primary)]'
                  : 'font-medium text-[var(--color-text-primary)]',
              )}
            >
              {primary?.name ?? 'Unknown'}
            </span>
            {hasNotes && (
              <StickyNote
                className="w-3 h-3 text-[var(--color-accent-deep)] flex-shrink-0 -translate-y-px"
                aria-label="Has notes"
              />
            )}
            {conversation.isStarred && (
              <Star
                className="w-3 h-3 text-[var(--color-accent-deep)] fill-[var(--color-accent-deep)] flex-shrink-0 -translate-y-px"
                aria-label="Starred"
              />
            )}
          </div>

          {/* Timestamp — fades on hover so actions can slide in here */}
          <span
            className={cn(
              'mono text-[11px] flex-shrink-0 group-hover/row:opacity-0',
              isUnread ? 'text-[var(--color-accent-deep)] font-medium' : 'text-[var(--color-text-tertiary)]',
            )}
            style={{ transition: 'opacity 180ms var(--ease-out-quart)' }}
          >
            {shortTime}
          </span>
        </div>

        <p
          className={cn(
            'text-[12.5px] leading-snug line-clamp-2 mt-1',
            isUnread ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-tertiary)]',
          )}
        >
          {conversation.lastMessage || 'No preview available'}
        </p>

        {(conversationLabels.length > 0 || followUpAt || conversation.source === 'sales_nav' || conversation.aiCategory) && (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {conversation.aiCategory && conversation.aiCategory !== 'other' && CATEGORY_STYLE[conversation.aiCategory].label && (
              <span
                className={cn(
                  'eyebrow text-[9px] px-1.5 py-0.5 rounded-full',
                  CATEGORY_STYLE[conversation.aiCategory].cls,
                )}
                title={conversation.aiSummary ?? undefined}
              >
                {CATEGORY_STYLE[conversation.aiCategory].label}
              </span>
            )}
            {conversation.source === 'sales_nav' && (
              <span className="eyebrow text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]">
                Sales Nav
              </span>
            )}
            {followUpAt && (
              followUpOverdue ? (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                  title="Follow up overdue"
                >
                  <AlertTriangle className="w-2.5 h-2.5" />
                  Overdue
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]"
                  title="Follow up scheduled"
                >
                  <BellRing className="w-2.5 h-2.5" />
                  Follow up
                </span>
              )
            )}
            {conversationLabels.map((l) => (
              <Badge key={l.id} label={l.name} color={l.color} />
            ))}
          </div>
        )}
      </div>

      {/* Action gutter — overlays timestamp on hover. Strong contrast against
          peach active rows + cream hover rows. */}
      <div
        className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 translate-x-1 pointer-events-none group-hover/row:opacity-100 group-hover/row:translate-x-0 group-hover/row:pointer-events-auto"
        style={{ transition: 'opacity 200ms var(--ease-out-quart), transform 200ms var(--ease-out-quart)' }}
      >
        <RowAction onClick={handleArchive} title="Archive (E)">
          <Archive className="w-3.5 h-3.5" />
        </RowAction>
        <RowAction onClick={handleSnooze} title="Snooze 24h (H)">
          <Clock className="w-3.5 h-3.5" />
        </RowAction>
        <RowAction
          onClick={handleStar}
          title={conversation.isStarred ? 'Unstar (S)' : 'Star (S)'}
          active={conversation.isStarred}
        >
          <Star className={cn('w-3.5 h-3.5', conversation.isStarred && 'fill-current')} />
        </RowAction>
      </div>

      {ctxMenu && (
        <ConvContextMenu
          conversation={conversation}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function RowAction({
  onClick,
  title,
  active,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center justify-center w-7 h-7 rounded-md',
        active
          ? 'text-[var(--color-accent-deep)] bg-[var(--color-card)]'
          : 'text-[var(--color-text-tertiary)] bg-[var(--color-card)]/80 hover:bg-[var(--color-card)] hover:text-[var(--color-text-primary)]',
        'shadow-[0_1px_2px_rgba(40,30,20,0.06)] border border-[var(--color-hairline)]',
        'active:scale-95',
      )}
      style={{
        transition: 'background-color 150ms var(--ease-out-quart), color 150ms var(--ease-out-quart), transform 100ms var(--ease-out-quart)',
      }}
    >
      {children}
    </button>
  );
}
