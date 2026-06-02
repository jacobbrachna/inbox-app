'use client';
import { useEffect, useState } from 'react';
import { Sparkles, RefreshCw, X, Check, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';

interface IcpDefinition {
  targetTitles?: string[];
  titlePatterns?: string[];
  keywords?: string[];
  seniorityWeights?: Record<string, number>;
  industries?: string[];
  excludeTitles?: string[];
}

interface AppStateFields {
  companyWebsiteUrl: string;
  companyLinkedInUrl: string;
  outreachGoal: string;
  myCompany: string;
  companyOneLiner: string;
  icpDefinition: IcpDefinition | null;
  icpBuiltAt: string | null;
}

// Compact editable chip list — each tag is removable, plus an add-new input
// at the end. Used for the title/keyword/industry arrays.
function ChipEditor({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const v = draft.trim();
    if (!v) return;
    if (items.includes(v)) { setDraft(''); return; }
    onChange([...items, v]);
    setDraft('');
  }
  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }
  return (
    <div>
      <label className="block text-[12px] font-medium text-[var(--color-text-secondary)] mb-1.5">
        {label} <span className="text-[var(--color-text-tertiary)] font-normal">({items.length})</span>
      </label>
      <div className="flex flex-wrap gap-1.5 items-center">
        {items.map((it, i) => (
          <span
            key={`${it}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-1 bg-[var(--color-card)] border border-[var(--color-hairline)] rounded-md text-[11.5px] text-[var(--color-text-primary)]"
          >
            {it}
            <button
              onClick={() => remove(i)}
              className="text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)]"
              title="Remove"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder={placeholder}
          className="px-2 py-1 text-[11.5px] bg-transparent border border-dashed border-[var(--color-hairline)] rounded-md text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-accent)] w-32"
        />
      </div>
    </div>
  );
}

export function IcpBuilder() {
  const [fields, setFields] = useState<AppStateFields>({
    companyWebsiteUrl: '',
    companyLinkedInUrl: '',
    outreachGoal: '',
    myCompany: '',
    companyOneLiner: '',
    icpDefinition: null,
    icpBuiltAt: null,
  });
  const [building, setBuilding] = useState(false);
  const [rescoring, setRescoring] = useState<{ updated: number; total: number } | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  // Pull current AppState into the form.
  useEffect(() => {
    fetch('/api/ai/key')
      .then((r) => r.json())
      .then((d) => {
        setFields({
          companyWebsiteUrl: d.companyWebsiteUrl ?? '',
          companyLinkedInUrl: d.companyLinkedInUrl ?? '',
          outreachGoal: d.outreachGoal ?? '',
          myCompany: d.myCompany ?? '',
          companyOneLiner: d.companyOneLiner ?? '',
          icpDefinition: d.icpDefinition ? safeParse(d.icpDefinition) : null,
          icpBuiltAt: d.icpBuiltAt ?? null,
        });
      })
      .catch(() => {});
  }, []);

  async function build() {
    setBuilding(true);
    setStatus(null);
    try {
      const r = await fetch('/api/icp/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          websiteUrl: fields.companyWebsiteUrl,
          linkedinUrl: fields.companyLinkedInUrl,
          outreachGoal: fields.outreachGoal,
          companyName: fields.myCompany,
          companyOneLiner: fields.companyOneLiner,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setStatus({ kind: 'err', msg: d.error ?? `HTTP ${r.status}` });
      } else {
        setFields((f) => ({ ...f, icpDefinition: d.definition, icpBuiltAt: new Date().toISOString() }));
        setStatus({
          kind: 'ok',
          msg: `Built · ${d.definition?.targetTitles?.length ?? 0} titles · ${d.definition?.keywords?.length ?? 0} keywords${d.sourceCharCount ? ` · ${d.sourceCharCount} chars from website` : ''}`,
        });
      }
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setBuilding(false);
    }
  }

  async function rescore() {
    setRescoring({ updated: 0, total: 0 });
    setStatus(null);
    try {
      const r = await fetch('/api/icp/rescore', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) {
        setStatus({ kind: 'err', msg: d.error ?? `HTTP ${r.status}` });
        setRescoring(null);
      } else {
        setStatus({ kind: 'ok', msg: `Re-scored ${d.updated} of ${d.total} conversations.` });
        setRescoring(null);
      }
    } catch (e) {
      setStatus({ kind: 'err', msg: e instanceof Error ? e.message : 'Failed' });
      setRescoring(null);
    }
  }

  // Save edited definition back to AppState. Triggered when the user tweaks
  // titles/keywords/etc. via the chip editors.
  async function saveDefinition(def: IcpDefinition) {
    setFields((f) => ({ ...f, icpDefinition: def }));
    await fetch('/api/ai/key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icpDefinition: JSON.stringify(def) }),
    });
  }

  const def = fields.icpDefinition;

  return (
    <div>
      <p className="text-[12px] text-[var(--color-text-secondary)] mb-3">
        Tell Relay about your company + who you target — we&apos;ll build a structured ICP that
        scores every conversation locally. One Claude call to build, free forever to score.
      </p>

      {/* Inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-[11.5px] font-medium text-[var(--color-text-secondary)] mb-1">Your company</label>
          <input
            value={fields.myCompany}
            onChange={(e) => setFields((f) => ({ ...f, myCompany: e.target.value }))}
            placeholder="Bedrock Data"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[11.5px] font-medium text-[var(--color-text-secondary)] mb-1">Company website</label>
          <input
            value={fields.companyWebsiteUrl}
            onChange={(e) => setFields((f) => ({ ...f, companyWebsiteUrl: e.target.value }))}
            placeholder="https://bedrock.com"
            className="input w-full"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-[11.5px] font-medium text-[var(--color-text-secondary)] mb-1">
            Company LinkedIn page <span className="text-[var(--color-text-tertiary)] font-normal">(optional)</span>
          </label>
          <input
            value={fields.companyLinkedInUrl}
            onChange={(e) => setFields((f) => ({ ...f, companyLinkedInUrl: e.target.value }))}
            placeholder="https://linkedin.com/company/bedrock-data"
            className="input w-full"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-[11.5px] font-medium text-[var(--color-text-secondary)] mb-1">
            Who do you target? <span className="text-[var(--color-text-tertiary)] font-normal">— more detail = better ICP</span>
          </label>
          <textarea
            value={fields.outreachGoal}
            onChange={(e) => setFields((f) => ({ ...f, outreachGoal: e.target.value }))}
            placeholder="e.g. Data security and information security leaders and practitioners, mostly leaders because they end up being the economic buyer. Companies handling sensitive customer data — fintech, healthcare, SaaS."
            rows={3}
            className="input w-full"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={build}
          disabled={building}
          className="flex items-center gap-2 px-3 py-2 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white text-[12px] font-semibold rounded-lg"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          <Sparkles className={cn('w-3.5 h-3.5', building && 'animate-pulse')} />
          {building ? 'Building…' : def ? 'Rebuild ICP' : 'Build ICP'}
        </button>
        {def && (
          <button
            onClick={rescore}
            disabled={!!rescoring}
            className="flex items-center gap-2 px-3 py-2 bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-secondary)] text-[12px] font-medium rounded-lg disabled:opacity-50"
            style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', rescoring && 'animate-spin')} />
            {rescoring ? 'Re-scoring…' : 'Re-score all conversations'}
          </button>
        )}
        {fields.icpBuiltAt && (
          <span className="text-[11px] text-[var(--color-text-tertiary)]">
            Built {new Date(fields.icpBuiltAt).toLocaleString()}
          </span>
        )}
      </div>

      {status && (
        <div
          className={cn(
            'mb-4 p-2.5 rounded-lg text-[12px] flex items-start gap-2',
            status.kind === 'ok'
              ? 'bg-[var(--color-success)]/10 border border-[var(--color-success)]/30 text-[var(--color-success)]'
              : 'bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 text-[var(--color-danger)]',
          )}
        >
          {status.kind === 'ok' ? <Check className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
          <span>{status.msg}</span>
        </div>
      )}

      {/* Definition editor — chips for each list, editable inline. */}
      {def && (
        <div className="space-y-4 pt-3 border-t border-[var(--color-hairline)]">
          <ChipEditor
            label="Target titles"
            items={def.targetTitles ?? []}
            onChange={(v) => saveDefinition({ ...def, targetTitles: v })}
            placeholder="Add title…"
          />
          <ChipEditor
            label="Title patterns (regex, case-insensitive)"
            items={def.titlePatterns ?? []}
            onChange={(v) => saveDefinition({ ...def, titlePatterns: v })}
            placeholder="director.*security"
          />
          <ChipEditor
            label="Keywords (in headline / about)"
            items={def.keywords ?? []}
            onChange={(v) => saveDefinition({ ...def, keywords: v })}
            placeholder="DSPM"
          />
          <ChipEditor
            label="Industries"
            items={def.industries ?? []}
            onChange={(v) => saveDefinition({ ...def, industries: v })}
            placeholder="Fintech"
          />
          <ChipEditor
            label="Exclude titles"
            items={def.excludeTitles ?? []}
            onChange={(v) => saveDefinition({ ...def, excludeTitles: v })}
            placeholder="Sales Engineer"
          />

          {def.seniorityWeights && (
            <div>
              <label className="block text-[12px] font-medium text-[var(--color-text-secondary)] mb-1.5">
                Seniority weights <span className="text-[var(--color-text-tertiary)] font-normal">(0–100)</span>
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(def.seniorityWeights).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="text-[11.5px] text-[var(--color-text-tertiary)] w-20 truncate">{k}</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={v}
                      onChange={(e) => {
                        const n = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
                        saveDefinition({ ...def, seniorityWeights: { ...def.seniorityWeights, [k]: n } });
                      }}
                      className="input w-16 text-center tabular-nums"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function safeParse(s: string | IcpDefinition | null): IcpDefinition | null {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}
