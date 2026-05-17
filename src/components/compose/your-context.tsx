'use client';
import { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';

// Editable form for the sender-side personalization fields stored on
// AppState (myCompany, myRole, companyOneLiner, outreachGoal,
// idealCustomerProfile, keyValueProps). These get injected into AI prompts
// alongside contact + document context.
//
// Also handles the LinkedIn URL + employment-history refresh — the same
// scraper that enriches a contact's profile, pointed at the user's own.
// Employment dates feed the pattern-generation filter so we only analyze
// messages from your current role.

type Fields = {
  myCompany: string;
  myRole: string;
  companyOneLiner: string;
  outreachGoal: string;
  idealCustomerProfile: string;
  keyValueProps: string;
  myProfileSlug: string;
};

const BLANK: Fields = {
  myCompany: '', myRole: '', companyOneLiner: '', outreachGoal: '',
  idealCustomerProfile: '', keyValueProps: '', myProfileSlug: '',
};

type EmploymentEntry = { role?: string | null; company?: string | null; from?: string | null; to?: string | null };

export function YourContext() {
  const [fields, setFields] = useState<Fields>(BLANK);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [employment, setEmployment] = useState<EmploymentEntry[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  async function load() {
    try {
      const d = await fetch('/api/ai/key').then((r) => r.json());
      setFields({
        myCompany: d.myCompany ?? '',
        myRole: d.myRole ?? '',
        companyOneLiner: d.companyOneLiner ?? '',
        outreachGoal: d.outreachGoal ?? '',
        idealCustomerProfile: d.idealCustomerProfile ?? '',
        keyValueProps: d.keyValueProps ?? '',
        myProfileSlug: d.myProfileSlug ?? '',
      });
      setRefreshedAt(d.myProfileRefreshedAt ?? null);
      try {
        const hist = d.myEmploymentHistory ? JSON.parse(d.myEmploymentHistory) : [];
        setEmployment(Array.isArray(hist) ? hist : []);
      } catch { setEmployment([]); }
    } catch {}
  }

  useEffect(() => { load(); }, []);

  async function save(opts: { silent?: boolean } = {}) {
    if (!opts.silent) setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/ai/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      if (!opts.silent) {
        setSavedAt(Date.now());
        setTimeout(() => setSavedAt(null), 4000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      if (!opts.silent) setSaving(false);
    }
  }

  function set<K extends keyof Fields>(k: K, v: string) {
    setFields((f) => ({ ...f, [k]: v }));
  }

  async function refreshFromLinkedIn() {
    setError(null);
    setRefreshMsg(null);
    const slugInput = fields.myProfileSlug.trim();
    if (!slugInput) { setError('Paste your LinkedIn URL or slug first, then Save.'); return; }
    // Save first so the server has the slug it needs to recognize the scrape
    // as "self" when the intercept fires.
    await save({ silent: true });

    const slug = slugInput.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? slugInput;
    const profileUrl = `https://www.linkedin.com/in/${slug}/`;

    setRefreshing(true);
    setRefreshMsg('Opening your LinkedIn profile…');

    const requestId = `me-enrich-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    function onResult(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type !== 'inboxpro-enrich-result' || ev.data.requestId !== requestId) return;
      window.removeEventListener('message', onResult);
      const resp = ev.data.response;
      if (resp?.ok) {
        // SDUI intercept lands asynchronously after page render; give it ~2s.
        setTimeout(() => {
          load().finally(() => {
            setRefreshing(false);
            setRefreshMsg('Profile refreshed');
            setTimeout(() => setRefreshMsg(null), 3000);
          });
        }, 2000);
      } else {
        setRefreshing(false);
        setRefreshMsg(resp?.reason ?? 'Could not refresh');
        setTimeout(() => setRefreshMsg(null), 4000);
      }
    }
    window.addEventListener('message', onResult);
    window.postMessage({ type: 'inboxpro-enrich-request', requestId, profileUrl }, '*');

    // Safety net — same timeout as contact enrichment.
    setTimeout(() => {
      window.removeEventListener('message', onResult);
      setRefreshing((r) => {
        if (r) {
          setRefreshMsg('Timed out — try again with LinkedIn open in another tab');
          setTimeout(() => setRefreshMsg(null), 4000);
        }
        return false;
      });
    }, 60_000);
  }

  return (
    <div className="space-y-4">
      <p className="text-[11.5px] text-[var(--color-text-tertiary)] -mt-1">
        Everything here flows into every AI draft and improvement suggestion. Tell Claude who you are, what you sell, and who you&apos;re trying to reach.
      </p>

      {/* LinkedIn URL + Refresh */}
      <div className="card p-3 bg-[var(--color-card-hover)] border border-[var(--color-hairline)] rounded-lg space-y-2">
        <label className="block text-[12px] font-semibold text-[var(--color-text-primary)]">Your LinkedIn URL</label>
        <p className="text-[11px] text-[var(--color-text-tertiary)] -mt-1">
          Used to pull your employment history so pattern analysis filters to your current role only.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={fields.myProfileSlug}
            onChange={(e) => set('myProfileSlug', e.target.value)}
            placeholder="https://linkedin.com/in/your-handle"
            className="input flex-1"
          />
          <button
            onClick={refreshFromLinkedIn}
            disabled={refreshing || !fields.myProfileSlug.trim()}
            className="press-feedback px-3 py-1.5 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white text-[12px] font-semibold rounded-md inline-flex items-center gap-1.5 whitespace-nowrap"
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh from LinkedIn'}
          </button>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-[var(--color-text-tertiary)]">
          {refreshedAt && <span>Last refreshed {formatDistanceToNowStrict(new Date(refreshedAt), { addSuffix: true })}</span>}
          {refreshMsg && <span className="text-[var(--color-accent)]">{refreshMsg}</span>}
        </div>
        {employment.length > 0 && (
          <div className="pt-2 border-t border-[var(--color-hairline)]">
            <p className="text-[11px] font-semibold text-[var(--color-text-secondary)] mb-1.5">Employment history</p>
            <ul className="space-y-1">
              {employment.map((e, i) => {
                const isCurrent = e.to === null || (typeof e.to === 'string' && /present/i.test(e.to));
                return (
                  <li key={i} className="text-[11.5px] text-[var(--color-text-primary)] flex items-baseline gap-2">
                    <span className="font-medium">{e.role || '?'}</span>
                    <span className="text-[var(--color-text-tertiary)]">at</span>
                    <span>{e.company || '?'}</span>
                    <span className="text-[10.5px] text-[var(--color-text-tertiary)]">
                      {e.from ?? '?'} – {isCurrent ? 'Present' : (e.to ?? '?')}
                    </span>
                    {isCurrent && <span className="text-[9.5px] uppercase tracking-wide bg-[var(--color-accent)]/15 text-[var(--color-accent)] px-1.5 py-0.5 rounded">current</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">Your role</label>
          <input
            type="text"
            value={fields.myRole}
            onChange={(e) => set('myRole', e.target.value)}
            placeholder="e.g. BDR, Account Executive"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">Your company</label>
          <input
            type="text"
            value={fields.myCompany}
            onChange={(e) => set('myCompany', e.target.value)}
            placeholder="e.g. Bedrock Data"
            className="input w-full"
          />
        </div>
      </div>

      <div>
        <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">What your company does</label>
        <input
          type="text"
          value={fields.companyOneLiner}
          onChange={(e) => set('companyOneLiner', e.target.value)}
          placeholder="One sentence — e.g. AI security and DSPM platform"
          className="input w-full"
        />
      </div>

      <div>
        <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">Outreach goal</label>
        <input
          type="text"
          value={fields.outreachGoal}
          onChange={(e) => set('outreachGoal', e.target.value)}
          placeholder="e.g. Book intro conversations with data security and governance leaders"
          className="input w-full"
        />
      </div>

      <div>
        <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">
          Ideal customer profile
          <span className="ml-2 text-[10px] font-normal text-[var(--color-text-tertiary)]">optional</span>
        </label>
        <textarea
          value={fields.idealCustomerProfile}
          onChange={(e) => set('idealCustomerProfile', e.target.value)}
          rows={3}
          placeholder="Titles, industries, company size, painpoints…"
          className="input w-full resize-y"
        />
      </div>

      <div>
        <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">
          Key value props
          <span className="ml-2 text-[10px] font-normal text-[var(--color-text-tertiary)]">optional</span>
        </label>
        <textarea
          value={fields.keyValueProps}
          onChange={(e) => set('keyValueProps', e.target.value)}
          rows={4}
          placeholder="3-5 specific things your product delivers — be concrete, this is the material Claude pulls from"
          className="input w-full resize-y"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => save()}
          disabled={saving}
          className="press-feedback px-3 py-1.5 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white text-[12px] font-semibold rounded-md"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-success)]">
            <Check className="w-3 h-3" /> Saved
          </span>
        )}
        {error && <span className="text-[11px] text-[var(--color-danger)]">{error}</span>}
      </div>
    </div>
  );
}
