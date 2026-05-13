'use client';
import { useEffect, useState } from 'react';
import { Zap, RefreshCw, AlertCircle, Check } from 'lucide-react';
import { useStore } from '@/store';

type State = 'idle' | 'syncing' | 'done' | 'error' | 'no-extension';

export function WelcomePanel() {
  const [state, setState] = useState<State>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const { loadFromServer } = useStore();

  // Detect extension via DOM marker
  useEffect(() => {
    function check() {
      const have = !!document.getElementById('inboxpro-bridge-marker');
      if (!have) {
        // Re-check briefly in case the marker hasn't been inserted yet
        setTimeout(() => {
          if (!document.getElementById('inboxpro-bridge-marker')) {
            setState((s) => (s === 'idle' ? 'no-extension' : s));
          }
        }, 1500);
      }
    }
    check();
  }, []);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type === 'inboxpro-refresh-progress') {
        setProgress(ev.data.message);
      }
      if (ev.data.type === 'inboxpro-full-sync-result') {
        const r = ev.data.response;
        if (r?.ok) {
          setState('done');
          setProgress(`Loaded ${r.count} conversations · ${r.messageCount} messages`);
          loadFromServer();
        } else {
          setState('error');
          setError(r?.reason ?? 'Sync failed');
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadFromServer]);

  function startSync() {
    if (!document.getElementById('inboxpro-bridge-marker')) {
      setState('no-extension');
      return;
    }
    setState('syncing');
    setProgress('Starting…');
    window.postMessage({ type: 'inboxpro-full-sync-request' }, '*');
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="card max-w-md w-full p-10 text-center">
        <div className="w-14 h-14 rounded-[14px] bg-[var(--color-accent-soft)] flex items-center justify-center mx-auto mb-4">
          <span className="text-[22px] font-bold text-[var(--color-accent-fg)]">i</span>
        </div>
        <h2 className="text-[24px] font-semibold tracking-tight text-[var(--color-text-primary)] mb-2">
          Welcome to InboxPro
        </h2>
        <p className="text-[13px] text-[var(--color-text-secondary)] mb-7">
          Your LinkedIn DMs and Sales Navigator threads, in one place.
        </p>

        {state === 'no-extension' && (
          <div className="bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded-xl p-4 mb-4 text-left">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-[var(--color-danger)] flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">Extension not detected</p>
                <p className="text-[11px] text-[var(--color-text-secondary)]">
                  Load <code className="mono bg-[var(--color-surface-2)] px-1 py-0.5 rounded text-[10px]">~/inbox-app/extension</code> at{' '}
                  <code className="mono bg-[var(--color-surface-2)] px-1 py-0.5 rounded text-[10px]">chrome://extensions</code>, then hard-refresh.
                </p>
              </div>
            </div>
          </div>
        )}

        {state === 'syncing' && (
          <div className="bg-[var(--color-accent-soft)] border border-[var(--color-accent)] rounded-xl p-4 mb-4">
            <p className="text-[12px] text-[var(--color-accent-fg)] font-medium">{progress || 'Syncing…'}</p>
            <p className="text-[11px] text-[var(--color-accent-fg)]/70 mt-1.5">
              5–15 minutes for the first sync. You can leave this open.
            </p>
          </div>
        )}

        {state === 'done' && (
          <div className="bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 rounded-xl p-4 mb-4">
            <div className="flex items-center justify-center gap-2">
              <Check className="w-4 h-4 text-[var(--color-success)]" />
              <p className="text-[12px] font-semibold text-[var(--color-success)]">{progress}</p>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div className="bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded-xl p-4 mb-4">
            <p className="text-[12px] text-[var(--color-danger)]">{error}</p>
          </div>
        )}

        <button
          onClick={startSync}
          disabled={state === 'syncing'}
          className="w-full px-6 py-2.5 rounded-xl bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent-fg)] disabled:bg-[var(--color-surface-2)] disabled:text-[var(--color-text-tertiary)] disabled:cursor-not-allowed text-white text-[13px] font-semibold flex items-center justify-center gap-2"
          style={{ transition: 'all 180ms var(--ease-out-quart)' }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${state === 'syncing' ? 'animate-spin' : ''}`} />
          {state === 'syncing' ? 'Syncing…' : state === 'done' ? 'Sync again' : 'Sync my LinkedIn inbox'}
        </button>

        <p className="text-[11px] text-[var(--color-text-tertiary)] mt-4">
          Make sure you&apos;re logged into LinkedIn in this Chrome profile.
        </p>
      </div>
    </div>
  );
}
