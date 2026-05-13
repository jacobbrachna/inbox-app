'use client';
import { useState } from 'react';
import { ExternalLink, Plus, MessageCircle, Star, Clock, BellRing, Check, Sparkles, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import { formatDistanceToNowStrict, format } from 'date-fns';
import type { AiCategory } from '@/types';

const CATEGORY_LABEL: Record<AiCategory, string> = {
  'cold-pitch': 'Cold pitch',
  'warm-lead': 'Warm lead',
  'client': 'Client',
  'recruiter': 'Recruiter',
  'intro': 'Intro',
  'spam': 'Spam',
  'other': 'Other',
};

export function ContactDetails() {
  const { activeConversationId, conversations, messages, labels, updateConversation, loadFromServer } = useStore();
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [classifying, setClassifying] = useState(false);

  async function classifyThis(convId: string) {
    setClassifying(true);
    try {
      await fetch('/api/ai/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationIds: [convId], force: true }),
      });
      loadFromServer();
    } finally {
      setClassifying(false);
    }
  }


  const convo = conversations.find((c) => c.id === activeConversationId);
  if (!convo) {
    return (
      <div
        className="card w-0 xl:w-[280px] opacity-0 xl:opacity-100 overflow-hidden flex-shrink-0 flex items-center justify-center p-6"
        style={{ transition: 'width 200ms var(--ease-out-quart), opacity 180ms var(--ease-out-quart)' }}
      >
        <div className="text-center">
          <div className="w-10 h-10 rounded-[10px] bg-[var(--color-surface-2)] flex items-center justify-center mx-auto mb-3">
            <MessageCircle className="w-4 h-4 text-[var(--color-text-tertiary)]" />
          </div>
          <p className="text-[12px] text-[var(--color-text-tertiary)]">
            Open a conversation to see contact details
          </p>
        </div>
      </div>
    );
  }

  const primary = convo.participants[0];
  const threadMsgs = messages[convo.id] ?? [];
  const firstMessageAt = threadMsgs.length > 0
    ? new Date(threadMsgs[0].sentAt)
    : null;
  const lastMessageAt = new Date(convo.lastMessageAt);
  const convoLabels = labels.filter((l) => convo.labels.includes(l.id));
  const followUpAt = convo.followUpAt ? new Date(convo.followUpAt) : null;
  const snoozedUntil = convo.snoozedUntil ? new Date(convo.snoozedUntil) : null;

  function toggleLabel(labelId: string) {
    const updated = convo!.labels.includes(labelId)
      ? convo!.labels.filter((l) => l !== labelId)
      : [...convo!.labels, labelId];
    updateConversation(convo!.id, { labels: updated });
  }

  function monogram(name: string | undefined): string {
    if (!name) return '·';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0]?.[0]?.toUpperCase() ?? '·';
    return `${parts[0][0] ?? ''}${parts[parts.length - 1][0] ?? ''}`.toUpperCase();
  }

  return (
    <aside
      className="w-0 xl:w-[280px] opacity-0 xl:opacity-100 flex-shrink-0 flex flex-col gap-3 overflow-y-auto"
      style={{ transition: 'width 200ms var(--ease-out-quart), opacity 180ms var(--ease-out-quart)' }}
    >
      {/* Profile card */}
      <div className="card p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-14 h-14 rounded-[12px] overflow-hidden bg-[var(--color-surface-2)] flex items-center justify-center flex-shrink-0">
            {primary?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={primary.avatarUrl}
                alt={primary?.name ?? ''}
                className="w-full h-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <span className="text-[16px] font-semibold text-[var(--color-text-secondary)]">
                {monogram(primary?.name)}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold tracking-tight text-[var(--color-text-primary)] truncate">
              {primary?.name ?? 'Unknown'}
            </h3>
            {primary?.headline && (
              <p className="text-[11.5px] text-[var(--color-text-tertiary)] leading-tight mt-1 line-clamp-2">
                {primary.headline}
              </p>
            )}
          </div>
        </div>

        {primary?.profileUrl ? (
          <a
            href={primary.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] font-medium text-[var(--color-accent-fg)] bg-[var(--color-accent-soft)] rounded-full hover:bg-[var(--color-accent)] hover:text-white"
            style={{ transition: 'all 160ms var(--ease-out-quart)' }}
          >
            <span className="font-semibold tracking-tight">in</span>
            View profile
            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
          </a>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] text-[var(--color-text-tertiary)] bg-[var(--color-surface-2)] rounded-full"
            title="The URL is captured automatically the next time you visit this person's profile on LinkedIn."
          >
            <span className="font-semibold tracking-tight opacity-60">in</span>
            URL not yet captured
          </span>
        )}
      </div>

      {/* AI summary */}
      {(convo.aiCategory || convo.aiSummary) && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="eyebrow flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-[var(--color-accent)]" /> AI summary
            </span>
            <button
              onClick={() => classifyThis(convo.id)}
              disabled={classifying}
              className="text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
              style={{ transition: 'color 140ms var(--ease-out-quart)' }}
              title="Re-run classification"
            >
              <RefreshCw className={cn('w-3 h-3', classifying && 'animate-spin')} />
            </button>
          </div>
          {convo.aiCategory && convo.aiCategory !== 'other' && (
            <div className="inline-block mb-2 text-[10.5px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]">
              {CATEGORY_LABEL[convo.aiCategory]}
            </div>
          )}
          {convo.aiSummary && (
            <p className="text-[12px] text-[var(--color-text-secondary)] leading-relaxed">{convo.aiSummary}</p>
          )}
        </div>
      )}

      {!convo.aiCategory && !convo.aiSummary && (
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <span className="eyebrow flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-[var(--color-text-tertiary)]" /> AI summary
            </span>
            <button
              onClick={() => classifyThis(convo.id)}
              disabled={classifying}
              className="text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] disabled:opacity-50"
              style={{ transition: 'color 140ms var(--ease-out-quart)' }}
            >
              {classifying ? 'Classifying…' : 'Classify this thread'}
            </button>
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="card p-3">
        <div className="grid grid-cols-3 gap-1.5">
          <QuickAction
            label={convo.isStarred ? 'Starred' : 'Star'}
            icon={<Star className={cn('w-3.5 h-3.5', convo.isStarred && 'fill-current')} />}
            active={convo.isStarred}
            onClick={() => updateConversation(convo.id, { isStarred: !convo.isStarred })}
          />
          <QuickAction
            label={snoozedUntil ? 'Snoozed' : 'Snooze'}
            icon={<Clock className="w-3.5 h-3.5" />}
            active={!!snoozedUntil}
            onClick={() => {
              if (snoozedUntil) {
                updateConversation(convo.id, { status: 'read', snoozedUntil: null });
              } else {
                updateConversation(convo.id, {
                  status: 'snoozed',
                  snoozedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                });
              }
            }}
          />
          <QuickAction
            label={followUpAt ? 'Following' : 'Follow up'}
            icon={<BellRing className="w-3.5 h-3.5" />}
            active={!!followUpAt}
            onClick={() => {
              if (followUpAt) {
                updateConversation(convo.id, { followUpAt: null });
              } else {
                const d = new Date(); d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0);
                updateConversation(convo.id, { followUpAt: d.toISOString() });
              }
            }}
          />
        </div>
      </div>

      {/* Tags */}
      <div className="card p-4 relative">
        <div className="flex items-center justify-between mb-3">
          <span className="eyebrow">Tags</span>
          <button
            onClick={() => setShowLabelPicker(!showLabelPicker)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded-md hover:bg-[var(--color-card-hover)]"
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          >
            <Plus className="w-3 h-3" />
            Add tag
          </button>
        </div>
        {convoLabels.length === 0 ? (
          <p className="text-[11.5px] text-[var(--color-text-tertiary)]">No tags yet</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {convoLabels.map((l) => (
              <button
                key={l.id}
                onClick={() => toggleLabel(l.id)}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
                style={{
                  backgroundColor: `${l.color}22`,
                  color: l.color,
                }}
                title={`Remove ${l.name}`}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
              </button>
            ))}
          </div>
        )}
        {showLabelPicker && (
          <div
            className="absolute top-full left-0 right-0 mt-1 z-50 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-xl py-1 overflow-hidden"
            style={{ boxShadow: 'var(--shadow-raised)' }}
          >
            {labels.length === 0 ? (
              <p className="text-[11px] text-[var(--color-text-tertiary)] px-3 py-2">No labels available — create one in the sidebar</p>
            ) : (
              labels.map((l) => (
                <button
                  key={l.id}
                  onClick={() => toggleLabel(l.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] hover:bg-[var(--color-card-hover)]"
                  style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: l.color }} />
                  <span className="flex-1 text-left text-[var(--color-text-primary)]">{l.name}</span>
                  {convo.labels.includes(l.id) && <Check className="w-3 h-3 text-[var(--color-accent)]" />}
                </button>
              ))
            )}
            <div className="border-t border-[var(--color-hairline)] my-1" />
            <button
              onClick={() => setShowLabelPicker(false)}
              className="w-full px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-card-hover)]"
              style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      {/* Enrichment */}
      {convo.enrichment && (convo.enrichment.role || convo.enrichment.company || convo.enrichment.location) && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="eyebrow">Details</span>
            {(convo.enrichment as { source?: string }).source === 'dom-capture' ? (
              <span className="text-[9.5px] text-[var(--color-success)] uppercase tracking-wider font-semibold">verified</span>
            ) : (convo.enrichment as { source?: string }).source === 'ai-headline' ? (
              <span className="text-[9.5px] text-[var(--color-text-tertiary)] uppercase tracking-wider">from headline</span>
            ) : null}
          </div>
          <div className="space-y-1.5">
            {convo.enrichment.role && <DetailRow label="Role" value={convo.enrichment.role} />}
            {convo.enrichment.company && <DetailRow label="Company" value={convo.enrichment.company} />}
            {convo.enrichment.location && <DetailRow label="Location" value={convo.enrichment.location} />}
            {convo.enrichment.industry && <DetailRow label="Industry" value={convo.enrichment.industry} />}
          </div>
        </div>
      )}

      {/* Details */}
      <div className="card p-4">
        <div className="eyebrow mb-3">Details</div>
        <DetailRow
          label="Source"
          value={convo.source === 'sales_nav' ? 'Sales Navigator' : 'LinkedIn DM'}
        />
        <DetailRow
          label="Messages"
          value={String(threadMsgs.length)}
        />
        {firstMessageAt && (
          <DetailRow
            label="First contact"
            value={format(firstMessageAt, 'MMM d, yyyy')}
            hint={formatDistanceToNowStrict(firstMessageAt, { addSuffix: true })}
          />
        )}
        <DetailRow
          label="Last message"
          value={formatDistanceToNowStrict(lastMessageAt, { addSuffix: true })}
          hint={format(lastMessageAt, 'MMM d, h:mm a')}
        />
        {convo.unreadCount > 0 && (
          <DetailRow
            label="Unread"
            value={String(convo.unreadCount)}
            valueColor="var(--color-accent)"
          />
        )}
        {followUpAt && (
          <DetailRow
            label="Follow up"
            value={format(followUpAt, 'MMM d, h:mm a')}
            valueColor={followUpAt.getTime() < Date.now() ? 'var(--color-danger)' : 'var(--color-accent)'}
          />
        )}
      </div>

      {/* Notes preview (full editing happens in the thread) */}
      {convo.notes && convo.notes.trim().length > 0 && (
        <div className="card p-4">
          <div className="eyebrow mb-2">Notes</div>
          <p className="text-[12px] text-[var(--color-text-secondary)] leading-relaxed whitespace-pre-wrap">
            {convo.notes}
          </p>
        </div>
      )}
    </aside>
  );
}

function QuickAction({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-1 px-2 py-2 rounded-lg text-[10px] font-medium',
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-card-hover)] hover:text-[var(--color-text-primary)]',
      )}
      style={{ transition: 'all 160ms var(--ease-out-quart)' }}
    >
      <span className={active ? 'text-[var(--color-accent-deep)]' : 'text-[var(--color-text-tertiary)]'}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function DetailRow({
  label,
  value,
  hint,
  valueColor,
}: {
  label: string;
  value: string;
  hint?: string;
  valueColor?: string;
}) {
  return (
    <div className="flex items-baseline justify-between py-1.5">
      <span className="text-[11.5px] text-[var(--color-text-tertiary)]">{label}</span>
      <div className="text-right">
        <div
          className="text-[12px] font-medium"
          style={{ color: valueColor || 'var(--color-text-primary)' }}
        >
          {value}
        </div>
        {hint && (
          <div className="mono text-[9.5px] text-[var(--color-text-tertiary)] mt-0.5">{hint}</div>
        )}
      </div>
    </div>
  );
}
