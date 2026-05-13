'use client';
import { useEffect, useState, useCallback } from 'react';
import { Check, AlertCircle, Puzzle, MessagesSquare, Download, FileText, Sparkles, ArrowRight, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStore } from '@/store';

// Steps in order. Order matters — index used in progress dots + persisted state.
const STEPS = [
  { id: 'extension', label: 'Extension', icon: Puzzle, optional: false },
  { id: 'signin', label: 'Sign in', icon: MessagesSquare, optional: false },
  { id: 'sync', label: 'Sync', icon: Download, optional: false },
  { id: 'import', label: 'Import', icon: FileText, optional: true },
  { id: 'ai', label: 'AI', icon: Sparkles, optional: true },
  { id: 'done', label: 'Done', icon: Check, optional: false },
] as const;

type StepId = typeof STEPS[number]['id'];

const STORAGE_KEY = 'inboxpro-onboarding-step';
const COMPLETED_KEY = 'inboxpro-onboarded';

export function OnboardingWizard({ preview = false }: { preview?: boolean }) {
  const { conversations, loadFromServer } = useStore();
  const [step, setStep] = useState<number>(() => {
    // Preview mode always starts at step 0 so you can walk through cleanly.
    if (preview) return 0;
    if (typeof window === 'undefined') return 0;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? Math.max(0, Math.min(STEPS.length - 1, n)) : 0;
  });
  const [extensionReady, setExtensionReady] = useState(false);

  // Persist current step (skip in preview — don't pollute real state)
  useEffect(() => {
    if (preview) return;
    try { window.localStorage.setItem(STORAGE_KEY, String(step)); } catch {}
  }, [step, preview]);

  // Poll for extension bridge marker — auto-advances when detected
  useEffect(() => {
    function check() {
      setExtensionReady(!!document.getElementById('inboxpro-bridge-marker'));
    }
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, []);

  // If user reloads after sync ran, skip ahead. Disabled in preview so you can
  // step through the whole flow even with a populated DB.
  useEffect(() => {
    if (preview) return;
    if (conversations.length > 0 && step < 3) {
      setStep(3);
    }
  }, [conversations.length, step, preview]);

  const current = STEPS[step];
  const onLast = step === STEPS.length - 1;

  function goNext() { if (step < STEPS.length - 1) setStep(step + 1); }
  function goBack() { if (step > 0) setStep(step - 1); }
  function finish() {
    try { window.localStorage.setItem(COMPLETED_KEY, '1'); } catch {}
    try { window.localStorage.removeItem(STORAGE_KEY); } catch {}
    // Force a re-render of the page so the wizard unmounts and the inbox renders
    window.location.reload();
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
          {current.id === 'sync' && <SyncStep onComplete={() => { loadFromServer(); goNext(); }} />}
          {current.id === 'import' && <ImportStep />}
          {current.id === 'ai' && <AiKeyStep />}
          {current.id === 'done' && <DoneStep />}
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
              >
                Skip
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

function ExtensionStep({ ready, onContinue }: { ready: boolean; onContinue: () => void }) {
  // Auto-advance when extension detected so user doesn't have to hit Continue
  useEffect(() => {
    if (ready) {
      const t = setTimeout(onContinue, 800);
      return () => clearTimeout(t);
    }
  }, [ready, onContinue]);

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
              <span>Open <code className="kbd mx-0.5">chrome://extensions</code> in a new tab</span>
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
              <span>Select the <code className="kbd mx-0.5">extension</code> folder inside your inbox-app directory</span>
            </li>
          </ol>
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
  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        Sign into LinkedIn and Sales Navigator
      </h2>
      <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
        Open LinkedIn and Sales Navigator in new tabs and make sure you're signed
        in. InboxPro uses your existing browser session — no passwords needed.
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
          <ArrowRight className="w-4 h-4 text-[var(--color-text-tertiary)]" />
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
          <ArrowRight className="w-4 h-4 text-[var(--color-text-tertiary)]" />
        </a>
      </div>

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

function SyncStep({ onComplete }: { onComplete: () => void }) {
  const [state, setState] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type === 'inboxpro-li-api-sync-progress') {
        const p = ev.data.progress || {};
        if (p.phase === 'inbox') {
          setProgress(`Pulling ${p.category || ''} · ${p.convs ?? 0} convs · ${p.pages ?? 0} pages`);
        } else if (p.phase === 'messages') {
          setProgress(`Fetching message history · ${p.fetched ?? 0} / ${p.total ?? 0} threads`);
        }
      }
      if (ev.data.type === 'inboxpro-li-initial-sync-api-result') {
        const r = ev.data.response;
        if (r?.ok) {
          setState('done');
          setProgress(`Loaded ${r.convs ?? 0} conversations · ${r.msgs ?? 0} messages`);
          setTimeout(onComplete, 1500);
        } else {
          setState('error');
          setError(r?.reason ?? 'Sync failed');
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onComplete]);

  function start() {
    setState('syncing');
    setProgress('Starting…');
    // Use the API-driven sync (background service worker, no LinkedIn tab needed)
    window.postMessage({ type: 'inboxpro-li-initial-sync-api', deepFetch: true }, '*');
  }

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        Sync your LinkedIn inbox
      </h2>
      <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
        We'll pull your LinkedIn DMs directly via the LinkedIn API. No tab to
        keep open, no scrolling — just <strong className="text-[var(--color-text-primary)]">leave
        this page open while it runs</strong>. Usually 3-10 minutes depending on
        inbox size.
      </p>
      <p className="text-[12px] text-[var(--color-text-tertiary)] mt-2 leading-relaxed">
        If you use Sales Navigator, open it after this completes and click
        the floating <em>"Sync this SN inbox"</em> button to pull those too.
      </p>

      {state === 'idle' && (
        <button
          onClick={start}
          className="mt-5 w-full px-4 py-3 rounded-xl bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white text-[13px] font-semibold active:scale-[0.99]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart), transform 80ms var(--ease-out-quart)' }}
        >
          Start sync
        </button>
      )}
      {state === 'syncing' && (
        <div className="mt-5 p-4 rounded-xl bg-[var(--color-accent-soft)] border border-[var(--color-accent)]/30">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
            <p className="text-[13px] font-medium text-[var(--color-accent-fg)]">{progress || 'Syncing…'}</p>
          </div>
        </div>
      )}
      {state === 'done' && (
        <div className="mt-5 p-4 rounded-xl bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 flex items-center gap-3">
          <Check className="w-5 h-5 text-[var(--color-success)]" strokeWidth={2.5} />
          <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">{progress}</p>
        </div>
      )}
      {state === 'error' && (
        <div className="mt-5 p-4 rounded-xl bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30">
          <p className="text-[12.5px] text-[var(--color-danger)]">{error}</p>
          <button
            onClick={start}
            className="mt-3 text-[12px] font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-deep)]"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

function ImportStep() {
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const onFile = useCallback(async (file: File) => {
    setUploading(true);
    setStatus(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/import/linkedin-connections', { method: 'POST', body: fd });
      const d = await r.json();
      if (r.ok) {
        setStatus({ ok: true, msg: `Matched ${d.matched ?? 0} of ${d.total ?? 0} contacts.` });
      } else {
        setStatus({ ok: false, msg: d.error ?? 'Import failed' });
      }
    } catch (e) {
      setStatus({ ok: false, msg: e instanceof Error ? e.message : 'Import failed' });
    } finally {
      setUploading(false);
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
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  async function save() {
    if (!key.trim()) return;
    setStatus('saving');
    setError('');
    try {
      const r = await fetch('/api/ai/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key.trim() }),
      });
      const d = await r.json();
      if (r.ok) {
        setStatus('saved');
      } else {
        setStatus('error');
        setError(d.error ?? 'Failed to save key');
      }
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        Enable AI features (optional)
      </h2>
      <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
        Add your Anthropic API key to unlock Draft Reply, Improve Draft, Smart Search,
        and auto-classification. Key stored locally in SQLite, never sent anywhere
        except api.anthropic.com.
      </p>

      <a
        href="https://console.anthropic.com/settings/keys"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 mt-3 text-[12px] text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] hover:underline"
      >
        Get a key from console.anthropic.com <ArrowRight className="w-3 h-3" />
      </a>

      <div className="mt-4">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-…"
          className="input w-full mono"
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        />
        <button
          onClick={save}
          disabled={!key.trim() || status === 'saving'}
          className={cn(
            'mt-3 px-4 py-1.5 rounded-lg text-[12.5px] font-semibold',
            key.trim() && status !== 'saving'
              ? 'bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white'
              : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] cursor-not-allowed',
          )}
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : 'Save key'}
        </button>
        {error && <p className="text-[12px] text-[var(--color-danger)] mt-2">{error}</p>}
      </div>
    </div>
  );
}

function DoneStep() {
  return (
    <div className="text-center py-4">
      <div className="w-16 h-16 rounded-full bg-[var(--color-success)]/10 flex items-center justify-center mx-auto mb-4">
        <Check className="w-8 h-8 text-[var(--color-success)]" strokeWidth={2.5} />
      </div>
      <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-text-primary)]">
        You're all set
      </h2>
      <p className="text-[13px] text-[var(--color-text-secondary)] mt-2 leading-relaxed max-w-[400px] mx-auto">
        InboxPro will keep your inbox in sync automatically. Keep a LinkedIn or
        Sales Nav tab open in this browser and new messages will land in real time.
      </p>
    </div>
  );
}
