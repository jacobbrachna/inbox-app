'use client';
import { useEffect, useState } from 'react';
import { Eye, EyeOff, Check, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';

export function AiSettings() {
  const [hasKey, setHasKey] = useState(false);
  const [mask, setMask] = useState<string | null>(null);
  const [styleNote, setStyleNote] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Classify state lives in the global store so progress survives navigation.
  // We derive the inline status message from the store's progress counters.
  const classifyState = useStore((s) => s.classifyState);
  const classifyProgress = useStore((s) => s.classifyProgress);
  const classifyError = useStore((s) => s.classifyError);
  const runClassify = useStore((s) => s.classifyAll);
  const classifyMsg =
    classifyState === 'running'
      ? classifyProgress.total === 0
        ? 'Finding unclassified conversations…'
        : `Classifying ${classifyProgress.done}–${Math.min(classifyProgress.done + 25, classifyProgress.total)} of ${classifyProgress.total}…`
      : classifyState === 'done'
        ? classifyProgress.total === 0
          ? 'Everything is already classified.'
          : `Classified ${classifyProgress.total} conversations.`
        : classifyState === 'error'
          ? classifyError ?? 'Failed'
          : '';

  useEffect(() => {
    fetch('/api/ai/key')
      .then((r) => r.json())
      .then((d) => {
        setHasKey(!!d.hasKey);
        setMask(d.mask ?? null);
        setStyleNote(d.styleNote ?? '');
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, string> = { styleNote };
      if (keyInput.trim()) body.apiKey = keyInput.trim();
      const r = await fetch('/api/ai/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg: string = err.error ?? `HTTP ${r.status}`;
        // Common case: Prisma client stale after schema change → server restart needed
        if (msg.includes('Unknown argument `anthropicApiKey`') || msg.includes('Invalid')) {
          setSaveError('Prisma client is stale. Restart your dev server (Ctrl+C then `npm run dev`) and try again.');
        } else {
          setSaveError(msg);
        }
        return;
      }
      setSavedAt(Date.now());
      if (keyInput.trim()) {
        setHasKey(true);
        setMask(`…${keyInput.trim().slice(-4)}`);
        setKeyInput('');
      }
      setTimeout(() => setSavedAt(null), 4000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Delegates to the store's classifyAll so both this panel and Diagnostics
  // share a single in-flight run + progress.
  async function classifyAll() {
    await runClassify();
  }

  return (
    <div className="space-y-4">
      {/* API key */}
      <div>
        <label className="block text-[13px] font-semibold text-[var(--color-text-primary)] mb-1">
          Anthropic API key
        </label>
        <p className="text-[11.5px] text-[var(--color-text-tertiary)] mb-2">
          Stored locally on this machine, in your SQLite DB. Never sent to any other server.{' '}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent)] hover:text-[var(--color-accent-deep)]"
          >
            Get one →
          </a>
        </p>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={hasKey ? `Current: ${mask}` : 'sk-ant-…'}
              className="input w-full pr-9 mono text-[12px]"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
              style={{ transition: 'color 140ms var(--ease-out-quart)' }}
              title={showKey ? 'Hide' : 'Show'}
            >
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Style note */}
      <div>
        <label className="block text-[13px] font-semibold text-[var(--color-text-primary)] mb-1">
          Your style note
          <span className="ml-2 text-[10px] font-normal text-[var(--color-text-tertiary)]">optional</span>
        </label>
        <p className="text-[11.5px] text-[var(--color-text-tertiary)] mb-2">
          Tell Claude how you write so drafts sound like you, not ChatGPT. Example:
          {' '}<em>&ldquo;Direct, sometimes casual. Lowercase often. No emojis. Short messages, max 3 lines.&rdquo;</em>
        </p>
        <textarea
          value={styleNote}
          onChange={(e) => setStyleNote(e.target.value)}
          rows={3}
          placeholder="Describe your writing voice in 1-3 sentences…"
          className="input w-full resize-y"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1.5 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white text-[12px] font-semibold rounded-md"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-success)]">
            <Check className="w-3 h-3" /> Saved
          </span>
        )}
        {saveError && (
          <span className="text-[11px] text-[var(--color-danger)]">{saveError}</span>
        )}
      </div>

      {/* Classify all */}
      <div className="border-t border-[var(--color-hairline)] pt-4 mt-2">
        <div className="mb-2">
          <p className="text-[13px] font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" />
            Auto-classify conversations
          </p>
          <p className="text-[11.5px] text-[var(--color-text-tertiary)]">
            Tags every conv as cold-pitch / warm-lead / client / recruiter / intro / spam. Uses Haiku — typically &lt;$0.01 per 100 convs.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={classifyAll}
            disabled={!hasKey || classifyState === 'running'}
            className={cn(
              'px-3 py-1.5 text-[12px] font-semibold rounded-md',
              !hasKey
                ? 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] cursor-not-allowed'
                : 'bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white disabled:opacity-50',
            )}
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          >
            {classifyState === 'running' ? 'Classifying…' : 'Classify all unclassified'}
          </button>
          {classifyMsg && (
            <span className={cn(
              'text-[11px]',
              classifyState === 'error' && 'text-[var(--color-danger)]',
              classifyState === 'done' && 'text-[var(--color-success)]',
              classifyState === 'running' && 'text-[var(--color-text-tertiary)]',
            )}>
              {classifyMsg}
            </span>
          )}
        </div>
      </div>

      {!hasKey && (
        <p className="text-[11px] text-[var(--color-text-tertiary)] mt-2">
          Save your API key above to enable AI features.
        </p>
      )}
    </div>
  );
}
