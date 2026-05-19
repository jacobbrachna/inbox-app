'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useStore } from '@/store';

type Mismatch = {
  currentName: string;
  storedName: string;
};

// Surfaces when the extension detects that the logged-in LinkedIn account
// no longer matches the one this Relay's data was synced from. Offers a
// one-click "Resync as [current account]" that clears data + identity and
// kicks off a fresh full sync. The banner stays visible until the user acts
// — dismissing only hides it until the next sync attempt re-fires the event.
export function AccountMismatchBanner() {
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { loadFromServer } = useStore();

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type === 'relay-account-mismatch') {
        setMismatch({
          currentName: String(ev.data.currentName || 'this LinkedIn account'),
          storedName: String(ev.data.storedName || 'a previous account'),
        });
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!mismatch) return null;

  async function resync() {
    setWorking(true);
    setErr(null);
    try {
      const r = await fetch('/api/reset?confirm=YES&resetProfile=1', { method: 'POST' });
      if (!r.ok) throw new Error(`reset failed: ${r.status}`);
      // Reload local state so the UI clears the old data immediately.
      await loadFromServer();
      // Kick off a fresh full sync using the new account.
      window.postMessage({ type: 'relay-li-initial-sync-api', deepFetch: true }, '*');
      setMismatch(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="card px-4 py-3 flex items-center gap-3 bg-[var(--color-warning-soft,var(--color-accent-soft))] border-[var(--color-warning,var(--color-accent))] flex-shrink-0">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 text-[var(--color-warning,var(--color-accent-fg))]" />
      <div className="flex-1 text-[12px] text-[var(--color-text-primary)]">
        You&apos;re signed into LinkedIn as <strong>{mismatch.currentName}</strong>, but Relay has data for <strong>{mismatch.storedName}</strong>.
        {err && <span className="block text-[var(--color-danger)] mt-1">{err}</span>}
      </div>
      <button
        onClick={resync}
        disabled={working}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white text-[12px] font-medium rounded-lg flex-shrink-0"
        style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
      >
        <RefreshCw className={working ? 'w-3 h-3 animate-spin' : 'w-3 h-3'} />
        {working ? 'Resyncing…' : `Resync as ${mismatch.currentName}`}
      </button>
      <button
        onClick={() => setMismatch(null)}
        className="text-[12px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] px-2"
      >
        Dismiss
      </button>
    </div>
  );
}
