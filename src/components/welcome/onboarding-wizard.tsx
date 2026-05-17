'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Check, AlertCircle, Puzzle, MessagesSquare, Download, FileText, Sparkles, ArrowRight, ArrowLeft, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';
import { storage } from '@/lib/storage';
import { useExtensionReady } from '@/lib/use-extension-ready';

// Steps in order. Order matters — index used in progress dots + persisted state.
const STEPS = [
  { id: 'extension', label: 'Extension', icon: Puzzle, optional: false },
  { id: 'signin', label: 'Sign in', icon: MessagesSquare, optional: false },
  { id: 'import', label: 'Import', icon: FileText, optional: true },
  { id: 'ai', label: 'AI', icon: Sparkles, optional: true },
  { id: 'done', label: 'Done', icon: Check, optional: false },
] as const;

type StepId = typeof STEPS[number]['id'];

interface OnboardingWizardProps {
  preview?: boolean;
  /** Called when the user finishes the wizard. Parent flips its onboarded
   *  flag and re-renders into the inbox — no page reload needed. */
  onComplete?: () => void;
}

export function OnboardingWizard({ preview = false, onComplete }: OnboardingWizardProps) {
  const { conversations } = useStore();
  const [step, setStep] = useState<number>(() => {
    // Preview mode always starts at step 0 so you can walk through cleanly.
    if (preview) return 0;
    return Math.max(0, Math.min(STEPS.length - 1, storage.onboardingStep.get()));
  });
  const extensionReady = useExtensionReady();

  // Persist current step (skip in preview — don't pollute real state)
  useEffect(() => {
    if (preview) return;
    storage.onboardingStep.set(step);
  }, [step, preview]);

  // Auto-advance past Sign-in once the first batch of conversations lands.
  // Previously gated to >=20 as a reload safety; now we trust any positive
  // count because SignInStep listens for the sync events directly.
  useEffect(() => {
    if (preview) return;
    if (conversations.length > 0 && step === 1) {
      setStep(2);
    }
    // Reload-safety: if a user comes back with a populated DB and is somehow
    // earlier than Sign-in, jump them to Import directly.
    if (conversations.length >= 20 && step < 2) {
      setStep(2);
    }
  }, [conversations.length, step, preview]);

  const current = STEPS[step];
  const onLast = step === STEPS.length - 1;

  function goNext() { if (step < STEPS.length - 1) setStep(step + 1); }
  function goBack() { if (step > 0) setStep(step - 1); }
  function finish() {
    storage.onboarded.set(true);
    storage.onboardingStep.clear();
    // Hand off to the parent so it can flip its `onboarded` flag and
    // re-render into the inbox in-place. View Transitions API wraps the
    // swap in a clean cross-fade where supported.
    const handoff = () => {
      if (onComplete) onComplete();
      else window.location.reload(); // fallback for legacy callers
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (typeof doc.startViewTransition === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      doc.startViewTransition(handoff);
    } else {
      handoff();
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
      <div className="card max-w-[560px] w-full p-8" style={{ boxShadow: 'var(--shadow-raised)' }}>
        {/* Progress dots */}
        <div className="flex items-center justify-between mb-8" aria-label="Onboarding progress">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const isPast = i < step;
            const isCurrent = i === step;
            return (
              <div key={s.id} className="flex items-center flex-1 last:flex-none">
                <button
                  onClick={() => { if (i <= step) setStep(i); }}
                  disabled={i > step}
                  className={cn(
                    'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0',
                    isPast || isCurrent
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)]',
                    i <= step && 'cursor-pointer hover:opacity-90',
                  )}
                  style={{ transition: 'background-color 160ms var(--ease-out-quart)' }}
                  title={s.label}
                  aria-current={isCurrent}
                >
                  {isPast ? <Check className="w-3.5 h-3.5" strokeWidth={2.5} /> : <Icon className="w-3.5 h-3.5" />}
                </button>
                {i < STEPS.length - 1 && (
                  <div
                    className={cn(
                      'flex-1 h-px mx-1.5',
                      i < step ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-hairline)]',
                    )}
                    style={{ transition: 'background-color 200ms var(--ease-out-quart)' }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div className="min-h-[280px]">
          {current.id === 'extension' && <ExtensionStep ready={extensionReady} onContinue={goNext} />}
          {current.id === 'signin' && <SignInStep extensionReady={extensionReady} />}
          {current.id === 'import' && <ImportStep />}
          {current.id === 'ai' && <AiKeyStep />}
          {current.id === 'done' && <DoneStep onBackToSignIn={() => setStep(1)} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between mt-8 pt-5 border-t border-[var(--color-hairline)]">
          <button
            onClick={goBack}
            disabled={step === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <span className="text-[11px] mono text-[var(--color-text-tertiary)] tabular-nums">
            Step {step + 1} of {STEPS.length}
          </span>
          <div className="flex items-center gap-1">
            {current.optional && !onLast && (
              <button
                onClick={goNext}
                className="px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)] rounded-lg"
                style={{ transition: 'background-color 140ms var(--ease-out-quart), color 140ms var(--ease-out-quart)' }}
                title={current.id === 'import' ? 'You can import in Settings later' : 'You can add a key in Settings later'}
              >
                {current.id === 'import' ? 'Skip — I\'ll import later' : 'Skip — add a key later'}
              </button>
            )}
            {!onLast ? (
              <button
                onClick={goNext}
                disabled={current.id === 'extension' && !extensionReady}
                className={cn(
                  'inline-flex items-center gap-1.5 px-4 py-1.5 text-[12.5px] font-semibold rounded-lg',
                  (current.id === 'extension' && !extensionReady)
                    ? 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] cursor-not-allowed'
                    : 'bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white active:scale-[0.97]',
                )}
                style={{ transition: 'background-color 140ms var(--ease-out-quart), transform 80ms var(--ease-out-quart)' }}
              >
                Continue <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={finish}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-[12.5px] font-semibold rounded-lg bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white active:scale-[0.97]"
                style={{ transition: 'background-color 140ms var(--ease-out-quart), transform 80ms var(--ease-out-quart)' }}
              >
                Open InboxPro <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Steps ────────────────────────────────────────────────────────────────

// Absolute path where both dev users (npm run dev) and .app users (the
// GetInboxPro launcher script clones into the same place) end up with
// the extension folder. Shown to the user with a copy button.
const EXTENSION_PATH = '~/Documents/inbox-app/extension';

function ExtensionStep({ ready, onContinue }: { ready: boolean; onContinue: () => void }) {
  const [copied, setCopied] = useState(false);

  // Auto-advance when extension detected so user doesn't have to hit Continue
  useEffect(() => {
    if (ready) {
      const t = setTimeout(onContinue, 800);
      return () => clearTimeout(t);
    }
  }, [ready, onContinue]);

  function copyPath() {
    void navigator.clipboard.writeText(EXTENSION_PATH).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        Connect the Chrome extension
      </h2>
      <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
        InboxPro reads your LinkedIn and Sales Navigator inboxes through a small
        Chrome extension. It runs locally — your data stays on your machine.
      </p>

      {ready ? (
        <div className="mt-5 p-4 rounded-xl bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 flex items-center gap-3">
          <Check className="w-5 h-5 text-[var(--color-success)]" strokeWidth={2.5} />
          <div>
            <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">Extension detected</p>
            <p className="text-[11.5px] text-[var(--color-text-secondary)] mt-0.5">Continuing automatically…</p>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <p className="eyebrow mb-2">Install in 4 clicks</p>
          <ol className="space-y-2 text-[12.5px] text-[var(--color-text-secondary)]">
            <li className="flex gap-2.5">
              <span className="mono text-[var(--color-text-tertiary)] tabular-nums flex-shrink-0">1.</span>
              <span>
                Open{' '}
                <a
                  href="chrome://extensions"
                  onClick={(e) => {
                    // chrome:// URLs can't be navigated from a webpage. Fall
                    // back to copying the URL so the user can paste it.
                    e.preventDefault();
                    void navigator.clipboard.writeText('chrome://extensions').catch(() => {});
                  }}
                  className="text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] hover:underline"
                  title="Click to copy"
                >
                  <code className="kbd mx-0.5">chrome://extensions</code>
                </a>{' '}
                in a new tab
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="mono text-[var(--color-text-tertiary)] tabular-nums flex-shrink-0">2.</span>
              <span>Toggle <strong className="text-[var(--color-text-primary)]">Developer mode</strong> on (top-right)</span>
            </li>
            <li className="flex gap-2.5">
              <span className="mono text-[var(--color-text-tertiary)] tabular-nums flex-shrink-0">3.</span>
              <span>Click <strong className="text-[var(--color-text-primary)]">Load unpacked</strong></span>
            </li>
            <li className="flex gap-2.5">
              <span className="mono text-[var(--color-text-tertiary)] tabular-nums flex-shrink-0">4.</span>
              <span>Select this folder:</span>
            </li>
          </ol>
          <div className="mt-2 ml-6 p-2.5 rounded-lg bg-[var(--color-surface-2)] flex items-center gap-2 max-w-full">
            <code className="mono text-[12px] text-[var(--color-text-primary)] truncate flex-1">{EXTENSION_PATH}</code>
            <button
              onClick={copyPath}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium flex-shrink-0',
                copied
                  ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)]',
              )}
              style={{ transition: 'background-color 140ms var(--ease-out-quart), color 140ms var(--ease-out-quart)' }}
            >
              {copied ? <Check className="w-3 h-3" strokeWidth={3} /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="mt-4 p-3 rounded-lg bg-[var(--color-accent-soft)] border border-[var(--color-accent)]/20 flex items-start gap-2.5">
            <AlertCircle className="w-3.5 h-3.5 text-[var(--color-accent)] flex-shrink-0 mt-0.5" />
            <p className="text-[11.5px] text-[var(--color-accent-fg)] leading-relaxed">
              Waiting for the extension. This page will auto-continue when detected.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function SignInStep({ extensionReady }: { extensionReady: boolean }) {
  // Live progress from the extension bridge. We surface the latest progress
  // message (e.g. "Fetched page 3 of 12"), the running sync result on
  // completion, and any failure reason. The parent wizard auto-advances
  // when conversations.length > 0, which loadFromServer triggers below.
  const { loadFromServer } = useStore();
  const [progress, setProgress] = useState<string | null>(null);
  const [syncDone, setSyncDone] = useState<{ count: number; messageCount: number } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type === 'inboxpro-refresh-progress' && typeof ev.data.message === 'string') {
        setProgress(ev.data.message);
        setSyncError(null);
      }
      if (ev.data.type === 'inboxpro-full-sync-result') {
        const r = ev.data.response;
        if (r?.ok) {
          setSyncDone({ count: r.count ?? 0, messageCount: r.messageCount ?? 0 });
          setProgress(null);
          // Pull the freshly synced conversations into the store, which
          // causes the parent wizard to auto-advance.
          void loadFromServer();
        } else {
          setSyncError(r?.reason ?? 'Sync failed');
          setProgress(null);
        }
        setStarting(false);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadFromServer]);

  function startSyncFromHere() {
    if (!extensionReady) return;
    setStarting(true);
    setSyncError(null);
    setProgress('Starting…');
    window.postMessage({ type: 'inboxpro-full-sync-request' }, '*');
  }

  const syncing = starting || progress !== null;

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        Sign into LinkedIn and sync your inbox
      </h2>
      <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
        Open LinkedIn messaging in a new tab, then come back here and click{' '}
        <strong className="text-[var(--color-text-primary)]">Start sync</strong>.
        For Sales Navigator, open <code className="kbd mx-0.5">linkedin.com/sales</code> too —
        the same sync covers both.
      </p>

      <div className="mt-5 grid gap-3">
        <a
          href="https://www.linkedin.com/messaging/"
          target="_blank"
          rel="noopener noreferrer"
          className="card p-4 flex items-center gap-3 hover:bg-[var(--color-card-hover)]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          <div className="w-10 h-10 rounded-[10px] bg-[var(--color-accent-soft)] flex items-center justify-center flex-shrink-0">
            <MessagesSquare className="w-5 h-5 text-[var(--color-accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">Open LinkedIn Messaging</p>
            <p className="text-[11.5px] text-[var(--color-text-tertiary)]">linkedin.com/messaging</p>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
        </a>
        <a
          href="https://www.linkedin.com/sales/home"
          target="_blank"
          rel="noopener noreferrer"
          className="card p-4 flex items-center gap-3 hover:bg-[var(--color-card-hover)]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          <div className="w-10 h-10 rounded-[10px] bg-[var(--color-accent-soft)] flex items-center justify-center flex-shrink-0">
            <MessagesSquare className="w-5 h-5 text-[var(--color-accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">Open Sales Navigator</p>
            <p className="text-[11.5px] text-[var(--color-text-tertiary)]">linkedin.com/sales <span className="text-[var(--color-text-muted)]">— optional if you don't use SN</span></p>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
        </a>
      </div>

      {/* Inline sync trigger so the user doesn't need to find the floating
          button on LinkedIn. The extension picks this up regardless. */}
      <button
        onClick={startSyncFromHere}
        disabled={!extensionReady || syncing}
        className={cn(
          'mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-[12.5px] font-semibold',
          (!extensionReady || syncing)
            ? 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] cursor-not-allowed'
            : 'bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white active:scale-[0.97]',
        )}
        style={{ transition: 'background-color 140ms var(--ease-out-quart), transform 80ms var(--ease-out-quart)' }}
      >
        <RefreshCw className={cn('w-3.5 h-3.5', syncing && 'animate-spin')} />
        {syncing ? 'Syncing…' : syncDone ? 'Re-sync' : 'Start sync'}
      </button>

      {/* Live progress card. The parent wizard auto-advances once
          conversations.length > 0, so this is mostly a confidence builder. */}
      {(syncing || syncDone || syncError) && (
        <div
          key={syncError ? 'err' : syncDone ? 'done' : 'in-progress'}
          className={cn(
            'mt-4 p-3 rounded-lg border flex items-start gap-2.5 view-fade-in',
            syncError && 'bg-[var(--color-danger)]/10 border-[var(--color-danger)]/30',
            !syncError && syncDone && 'bg-[var(--color-success)]/10 border-[var(--color-success)]/30',
            !syncError && !syncDone && 'bg-[var(--color-accent-soft)] border-[var(--color-accent)]/20',
          )}
        >
          {syncError ? (
            <AlertCircle className="w-3.5 h-3.5 text-[var(--color-danger)] flex-shrink-0 mt-0.5" />
          ) : syncDone ? (
            <Check className="w-3.5 h-3.5 text-[var(--color-success)] flex-shrink-0 mt-0.5" strokeWidth={2.5} />
          ) : (
            <RefreshCw className="w-3.5 h-3.5 text-[var(--color-accent)] flex-shrink-0 mt-0.5 animate-spin" />
          )}
          <div className="flex-1 min-w-0">
            {syncError ? (
              <p className="text-[11.5px] text-[var(--color-danger)] leading-relaxed">{syncError}</p>
            ) : syncDone ? (
              <p className="text-[11.5px] text-[var(--color-text-primary)] leading-relaxed">
                Loaded <strong>{syncDone.count}</strong> conversations · <strong>{syncDone.messageCount}</strong> messages.
                Continuing automatically…
              </p>
            ) : (
              <>
                <p className="text-[11.5px] text-[var(--color-accent-fg)] leading-relaxed font-medium">{progress}</p>
                <p className="text-[10.5px] text-[var(--color-accent-fg)]/70 mt-0.5">5–15 minutes for the first sync. Stay on this page.</p>
              </>
            )}
          </div>
        </div>
      )}

      {!extensionReady && (
        <div className="mt-4 p-3 rounded-lg bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 flex items-start gap-2.5">
          <AlertCircle className="w-3.5 h-3.5 text-[var(--color-danger)] flex-shrink-0 mt-0.5" />
          <p className="text-[11.5px] text-[var(--color-danger)] leading-relaxed">
            Extension not detected — go back to the previous step.
          </p>
        </div>
      )}
    </div>
  );
}

function ImportStep() {
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight upload when the user navigates away from this step
  // (or the wizard unmounts) — prevents setState-on-unmounted warnings.
  useEffect(() => () => abortRef.current?.abort(), []);

  const onFile = useCallback(async (file: File) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setUploading(true);
    setStatus(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/import/linkedin-connections', {
        method: 'POST',
        body: fd,
        signal: ac.signal,
      });
      const d = await r.json();
      if (ac.signal.aborted) return;
      if (r.ok) {
        setStatus({ ok: true, msg: `Matched ${d.matched ?? 0} of ${d.total ?? 0} contacts.` });
      } else {
        setStatus({ ok: false, msg: d.error ?? 'Import failed' });
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      setStatus({ ok: false, msg: e instanceof Error ? e.message : 'Import failed' });
    } finally {
      if (!ac.signal.aborted) setUploading(false);
    }
  }, []);

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        Import your LinkedIn connections
      </h2>
      <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
        Optional but recommended. LinkedIn lets you export your connections — uploading
        that file gives every conversation real headlines, companies, and profile URLs.
      </p>

      <details className="mt-4 group">
        <summary className="cursor-pointer text-[12px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] inline-flex items-center gap-1">
          How to download from LinkedIn
          <ArrowRight className="w-3 h-3 group-open:rotate-90" style={{ transition: 'transform 160ms var(--ease-out-quart)' }} />
        </summary>
        <ol className="mt-3 space-y-1.5 text-[12px] text-[var(--color-text-secondary)] pl-4 border-l-2 border-[var(--color-hairline)]">
          <li>1. Go to <a href="https://www.linkedin.com/mypreferences/d/download-my-data" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">Settings → Data Privacy → Get a copy of your data</a></li>
          <li>2. Select <strong className="text-[var(--color-text-primary)]">Want something in particular?</strong></li>
          <li>3. Check only <strong className="text-[var(--color-text-primary)]">Connections</strong></li>
          <li>4. Click <strong className="text-[var(--color-text-primary)]">Request archive</strong></li>
          <li>5. LinkedIn emails the zip in 10 minutes — a few hours</li>
          <li>6. Download it, then drop the zip below</li>
        </ol>
      </details>

      <label
        className="mt-5 block p-6 rounded-xl border-2 border-dashed border-[var(--color-hairline)] hover:border-[var(--color-accent)] cursor-pointer text-center"
        style={{ transition: 'border-color 140ms var(--ease-out-quart)' }}
      >
        <input
          type="file"
          accept=".zip,.csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
        />
        {uploading ? (
          <div className="flex items-center justify-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
            <div className="w-3.5 h-3.5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
            Importing…
          </div>
        ) : (
          <>
            <Download className="w-5 h-5 text-[var(--color-text-tertiary)] mx-auto mb-2" />
            <p className="text-[12.5px] text-[var(--color-text-secondary)]">Click to upload the LinkedIn export zip</p>
            <p className="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">Accepts .zip from LinkedIn or a raw Connections.csv</p>
          </>
        )}
      </label>

      {status && (
        <div className={cn(
          'mt-3 p-3 rounded-lg flex items-start gap-2.5',
          status.ok
            ? 'bg-[var(--color-success)]/10 border border-[var(--color-success)]/30'
            : 'bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30',
        )}>
          {status.ok
            ? <Check className="w-3.5 h-3.5 text-[var(--color-success)] flex-shrink-0 mt-0.5" strokeWidth={2.5} />
            : <AlertCircle className="w-3.5 h-3.5 text-[var(--color-danger)] flex-shrink-0 mt-0.5" />}
          <p className={cn('text-[12px]', status.ok ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-danger)]')}>{status.msg}</p>
        </div>
      )}
    </div>
  );
}

function AiKeyStep() {
  const [key, setKey] = useState('');
  // Two-phase status: save the key first, then verify it works by pinging
  // Anthropic with a 1-token Haiku call. The user sees clear stages instead
  // of "Saved" against a key that actually fails on first use.
  const [status, setStatus] = useState<'idle' | 'saving' | 'verifying' | 'verified' | 'error'>('idle');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // Cancel any in-flight save/verify when the step unmounts so we don't
  // poke state on a dead component.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function saveAndVerify() {
    if (!key.trim()) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setStatus('saving');
    setError('');
    try {
      const r = await fetch('/api/ai/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key.trim() }),
        signal: ac.signal,
      });
      const d = await r.json();
      if (ac.signal.aborted) return;
      if (!r.ok) {
        setStatus('error');
        setError(d.error ?? 'Failed to save key');
        return;
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed');
      return;
    }

    // Live verification — a 1-token Haiku ping confirms the key is real.
    setStatus('verifying');
    try {
      const r = await fetch('/api/ai/key/verify', {
        method: 'POST',
        signal: ac.signal,
      });
      const d = await r.json();
      if (ac.signal.aborted) return;
      if (r.ok && d.ok) {
        setStatus('verified');
      } else {
        setStatus('error');
        setError(d.error ?? 'Key saved but Anthropic rejected it. Double-check the value.');
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Verification failed');
    }
  }

  const busy = status === 'saving' || status === 'verifying';
  const verified = status === 'verified';

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        Enable AI features (optional)
      </h2>
      <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
        Add your Anthropic API key to unlock Draft Reply, Improve Draft, Smart Search,
        and auto-classification. Key stored locally in SQLite, never sent anywhere
        except api.anthropic.com. You can add this later in Settings.
      </p>

      <a
        href="https://console.anthropic.com/settings/keys"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 mt-3 text-[12px] text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] hover:underline"
      >
        Get a key from console.anthropic.com <ExternalLink className="w-3 h-3" />
      </a>

      <div className="mt-4">
        <input
          type="password"
          value={key}
          onChange={(e) => { setKey(e.target.value); if (status === 'error' || status === 'verified') setStatus('idle'); }}
          placeholder="sk-ant-…"
          className="input w-full mono"
          onKeyDown={(e) => { if (e.key === 'Enter') saveAndVerify(); }}
          disabled={busy || verified}
        />
        <button
          onClick={saveAndVerify}
          disabled={!key.trim() || busy || verified}
          className={cn(
            'mt-3 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[12.5px] font-semibold',
            verified
              ? 'bg-[var(--color-success)]/15 text-[var(--color-success)] cursor-default'
              : key.trim() && !busy
                ? 'bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white'
                : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] cursor-not-allowed',
          )}
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          {busy && <RefreshCw className="w-3 h-3 animate-spin" />}
          {verified && <Check className="w-3 h-3" strokeWidth={3} />}
          {status === 'saving' ? 'Saving…'
            : status === 'verifying' ? 'Verifying…'
            : verified ? 'Verified'
            : 'Save & verify key'}
        </button>
        {status === 'error' && <p className="text-[12px] text-[var(--color-danger)] mt-2">{error}</p>}
      </div>
    </div>
  );
}

function DoneStep({ onBackToSignIn }: { onBackToSignIn: () => void }) {
  const { conversations } = useStore();
  const count = conversations.length;
  const empty = count === 0;

  return (
    <div className="text-center py-4">
      <div className={cn(
        'w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4',
        empty ? 'bg-[var(--color-accent-soft)]' : 'bg-[var(--color-success)]/10',
      )}>
        {empty ? (
          <AlertCircle className="w-8 h-8 text-[var(--color-accent)]" strokeWidth={2.5} />
        ) : (
          <Check className="w-8 h-8 text-[var(--color-success)]" strokeWidth={2.5} />
        )}
      </div>
      <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        {empty ? 'Ready when you are' : "You're all set"}
      </h2>
      {empty ? (
        <>
          <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed max-w-[400px] mx-auto">
            Heads up — no conversations have synced yet. You can still open InboxPro
            and sync from there, or go back and run sync now.
          </p>
          <button
            onClick={onBackToSignIn}
            className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] hover:underline"
          >
            <ArrowLeft className="w-3 h-3" /> Back to Sign in
          </button>
        </>
      ) : (
        <>
          <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed max-w-[400px] mx-auto">
            <strong className="text-[var(--color-text-primary)]">{count.toLocaleString()}</strong>{' '}
            conversation{count === 1 ? '' : 's'} synced. InboxPro will keep your inbox up to date
            automatically — keep a LinkedIn or Sales Nav tab open and new messages land in real time.
          </p>
        </>
      )}
    </div>
  );
}
