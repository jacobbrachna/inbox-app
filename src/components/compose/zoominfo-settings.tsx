'use client';
import { useEffect, useState } from 'react';
import { Link2, Unlink, Check, AlertTriangle, RefreshCw, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Status {
  connected: boolean;
  connectedAt: string | null;
  expiresAt: string | null;
  hasCredentials: boolean;
}

// Settings block — Connect / Disconnect ZoomInfo. Polls /api/zoominfo/auth/status
// after kicking off OAuth so the UI flips to "Connected" the moment the
// callback completes (typically within a few seconds of the user clicking
// Approve in their browser).
export function ZoominfoSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshStatus() {
    try {
      const r = await fetch('/api/zoominfo/auth/status');
      const d = await r.json();
      setStatus(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load status');
    }
  }

  useEffect(() => {
    refreshStatus();
  }, []);

  async function connect() {
    setWorking(true);
    setError(null);
    try {
      const r = await fetch('/api/zoominfo/auth/start', { method: 'POST' });
      const d = await r.json();
      if (!r.ok || !d.authorizeUrl) {
        throw new Error(d.error ?? 'Failed to start OAuth');
      }
      // Open ZoomInfo's authorize page in the system browser.
      window.open(d.authorizeUrl, '_blank');
      // Poll status every 2s for up to 3 minutes — flips when the user
      // approves and the callback fires.
      const start = Date.now();
      const poll = setInterval(async () => {
        await refreshStatus();
        const fresh = await fetch('/api/zoominfo/auth/status').then((r) => r.json()).catch(() => null);
        if (fresh?.connected) {
          clearInterval(poll);
          setWorking(false);
        } else if (Date.now() - start > 3 * 60 * 1000) {
          clearInterval(poll);
          setWorking(false);
          setError('Connection timed out. Try again.');
        }
      }, 2000);
    } catch (e) {
      setWorking(false);
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect ZoomInfo? You can reconnect any time.')) return;
    setWorking(true);
    try {
      await fetch('/api/zoominfo/auth/disconnect', { method: 'POST' });
      await refreshStatus();
    } finally {
      setWorking(false);
    }
  }

  if (!status) {
    return <p className="text-[12px] text-[var(--color-text-tertiary)]">Loading…</p>;
  }

  if (!status.hasCredentials) {
    return (
      <div className="p-3 rounded-lg bg-[var(--color-warning-soft,var(--color-accent-soft))] border border-[var(--color-warning,var(--color-accent))] flex items-start gap-2 text-[12px]">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-[var(--color-warning,var(--color-accent-fg))]" />
        <span>
          ZoomInfo OAuth credentials aren&apos;t configured in this build. The integration is disabled.
        </span>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[12px] text-[var(--color-text-secondary)] mb-3">
        Pull signals (recent funding, hiring, exec moves, news) per contact straight from ZoomInfo.
        On-demand only — no background scraping. Requires a ZoomInfo seat with API access.
      </p>

      {status.connected ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 text-[var(--color-success)] text-[12px] font-medium rounded-lg">
            <Check className="w-3 h-3" /> Connected
          </span>
          {status.connectedAt && (
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              since {new Date(status.connectedAt).toLocaleDateString()}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={refreshStatus}
            disabled={working}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-secondary)] text-[11.5px] rounded-lg disabled:opacity-50"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            <RefreshCw className={cn('w-3 h-3', working && 'animate-spin')} />
            Refresh
          </button>
          <button
            onClick={disconnect}
            disabled={working}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-secondary)] text-[11.5px] rounded-lg disabled:opacity-50"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            <Unlink className="w-3 h-3" />
            Disconnect
          </button>
        </div>
      ) : (
        <button
          onClick={connect}
          disabled={working}
          className="flex items-center gap-2 px-3 py-2 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white text-[12px] font-semibold rounded-lg"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          <Link2 className="w-3.5 h-3.5" />
          {working ? 'Waiting for approval…' : 'Connect ZoomInfo'}
          {!working && <ExternalLink className="w-3 h-3 opacity-70" />}
        </button>
      )}

      {error && (
        <div className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</div>
      )}
    </div>
  );
}
