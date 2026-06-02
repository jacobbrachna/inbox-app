'use client';
import { useEffect, useState } from 'react';
import { Briefcase, DollarSign, Newspaper, Sparkles, RefreshCw, AlertTriangle, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';

interface EnrichedCompany {
  name?: string;
  description?: string;
  industries?: string[];
  employeeCount?: number;
  employeeRange?: string;
  revenue?: number;
  revenueRange?: string;
  recentFundingAmount?: number;
  recentFundingDate?: string;
  totalFundingAmount?: number;
  foundedYear?: number;
  metroArea?: string;
}

interface ScoopItem {
  scoopId: string;
  scoopType: string;
  description: string;
  originalPublishedDate?: string;
  link?: string;
}

interface NewsItem {
  title?: string;
  description?: string;
  publishingDate?: string;
  url?: string;
  category?: string;
}

interface CachedResponse {
  cached: boolean;
  pulledAt?: string | null;
  company?: EnrichedCompany | null;
  scoops?: ScoopItem[];
  news?: NewsItem[];
}

// Per-contact ZoomInfo signal panel. Shows cached enrichment when present;
// "Pull ZI signals" button fires a fresh /api/conversations/:id/zoominfo-pull
// when clicked. Hidden when ZI isn't connected.
export function ZoominfoPanel({ conversationId }: { conversationId: string }) {
  const [data, setData] = useState<CachedResponse | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  // Check connection status — hide the panel if disconnected, show the
  // "Connect first" hint instead.
  useEffect(() => {
    fetch('/api/zoominfo/auth/status')
      .then((r) => r.json())
      .then((d) => setConnected(!!d?.connected))
      .catch(() => setConnected(false));
  }, []);

  // Load cached enrichment for this conv. Doesn't fetch from ZI.
  useEffect(() => {
    setData(null);
    setError(null);
    if (!conversationId) return;
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/zoominfo-pull`)
      .then((r) => r.json())
      .then((d) => { if (d) setData(d); })
      .catch(() => {});
  }, [conversationId]);

  async function pull() {
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/zoominfo-pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setData({ cached: true, pulledAt: new Date().toISOString(), ...d });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setWorking(false);
    }
  }

  if (connected === null) return null; // initial load
  if (connected === false) return null; // hide entirely when not connected

  const company = data?.company;
  const scoops = data?.scoops ?? [];
  const news = data?.news ?? [];
  const hasData = !!company || scoops.length > 0 || news.length > 0;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="eyebrow flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" /> ZoomInfo signals
        </div>
        <button
          onClick={pull}
          disabled={working}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)] rounded-md disabled:opacity-50"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          title={hasData ? 'Re-pull from ZoomInfo' : 'Pull from ZoomInfo'}
        >
          <RefreshCw className={cn('w-3 h-3', working && 'animate-spin')} />
          {working ? 'Pulling…' : hasData ? 'Refresh' : 'Pull'}
        </button>
      </div>

      {error && (
        <div className="mb-3 p-2 rounded-md bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 text-[11.5px] text-[var(--color-danger)] flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!hasData && !error && (
        <p className="text-[11.5px] text-[var(--color-text-tertiary)]">
          Click <strong>Pull</strong> to fetch funding, hiring, and news signals for this contact&apos;s company.
        </p>
      )}

      {company && (
        <div className="mb-3">
          {company.description && (
            <p className="text-[11.5px] text-[var(--color-text-secondary)] mb-2 line-clamp-3">{company.description}</p>
          )}
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            {company.employeeRange && (
              <Stat label="Employees" value={company.employeeRange} />
            )}
            {company.revenueRange && (
              <Stat label="Revenue" value={company.revenueRange} />
            )}
            {company.recentFundingAmount && (
              <Stat
                label="Recent funding"
                value={`$${(company.recentFundingAmount / 1_000_000).toFixed(1)}M`}
                sub={company.recentFundingDate ?? undefined}
              />
            )}
            {company.totalFundingAmount && (
              <Stat
                label="Total funding"
                value={`$${(company.totalFundingAmount / 1_000_000).toFixed(1)}M`}
              />
            )}
            {company.foundedYear && (
              <Stat label="Founded" value={String(company.foundedYear)} />
            )}
            {company.metroArea && (
              <Stat label="HQ" value={company.metroArea} />
            )}
          </div>
        </div>
      )}

      {scoops.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium mb-1.5 flex items-center gap-1">
            <Briefcase className="w-3 h-3" /> Signals
          </div>
          <ul className="space-y-1.5">
            {scoops.slice(0, 6).map((s) => (
              <li key={s.scoopId} className="text-[11.5px] text-[var(--color-text-secondary)] leading-snug">
                <span className="text-[10px] mono px-1 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] mr-1.5">{s.scoopType}</span>
                {s.link ? (
                  <a href={s.link} target="_blank" rel="noreferrer" className="hover:underline">{s.description}</a>
                ) : s.description}
                {s.originalPublishedDate && (
                  <span className="text-[10px] text-[var(--color-text-tertiary)] ml-1">
                    · {new Date(s.originalPublishedDate).toLocaleDateString()}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {news.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium mb-1.5 flex items-center gap-1">
            <Newspaper className="w-3 h-3" /> Recent news
          </div>
          <ul className="space-y-1.5">
            {news.slice(0, 5).map((n, i) => (
              <li key={i} className="text-[11.5px] text-[var(--color-text-secondary)] leading-snug">
                {n.url ? (
                  <a href={n.url} target="_blank" rel="noreferrer" className="hover:underline inline-flex items-baseline gap-1">
                    {n.title || n.description}
                    <ExternalLink className="w-2.5 h-2.5 inline opacity-60" />
                  </a>
                ) : (n.title || n.description)}
                {n.publishingDate && (
                  <span className="text-[10px] text-[var(--color-text-tertiary)] ml-1">
                    · {new Date(n.publishingDate).toLocaleDateString()}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.pulledAt && (
        <p className="text-[10px] text-[var(--color-text-tertiary)] mt-3">
          Last pulled {new Date(data.pulledAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-md px-2 py-1.5">
      <div className="text-[9.5px] uppercase tracking-wider text-[var(--color-text-tertiary)] font-medium">{label}</div>
      <div className="text-[12px] font-medium text-[var(--color-text-primary)] tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">{sub}</div>}
    </div>
  );
}
