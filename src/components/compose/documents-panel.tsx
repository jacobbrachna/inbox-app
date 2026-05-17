'use client';
import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload, FileText, Check, X, ChevronDown, ChevronRight, Sparkles, Download, Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDistanceToNowStrict } from 'date-fns';

// Upload + manage reference documents (whitepapers, ICPs, case studies).
// Each doc is summarized by Claude on upload; the summary is injected into
// AI prompts when includeByDefault = true. PDFs go directly to Claude as
// a document content block; .txt/.md/paste land as rawText.

type DocRow = {
  id: string;
  title: string;
  kind: string;
  summary: string | null;
  includeByDefault: boolean;
  sourceFilename: string | null;
  sourceMime: string | null;
  createdAt: string;
};

const KIND_PRESETS = ['whitepaper', 'ICP', 'case-study', 'objection-handling', 'pricing', 'winning-patterns', 'other'];

// Quick YAML frontmatter parser — only handles k: v lines, nothing fancier.
// Returns { fields, body } where body is the text minus the frontmatter block.
function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: m[2] };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:application/pdf;base64,JVBE…  →  JVBE…
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('file read failed'));
    reader.readAsText(file);
  });
}

type PatternsMeta = {
  lastGeneratedAt: string | null;
  lastTitle: string | null;
  messagesSince: number;
  windowStart: string | null;
  windowEntry: { role?: string | null; company?: string | null; from?: string | null } | null;
  eligibleInWindow: number;
};

export function DocumentsPanel() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [patternsMeta, setPatternsMeta] = useState<PatternsMeta | null>(null);
  const [genState, setGenState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [genMsg, setGenMsg] = useState('');

  async function reload() {
    setLoading(true);
    try {
      const [docsRes, metaRes] = await Promise.all([
        fetch('/api/documents').then((r) => r.json()),
        fetch('/api/patterns').then((r) => r.json()),
      ]);
      setDocs(docsRes.documents ?? []);
      setPatternsMeta(metaRes);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  async function toggleDefault(id: string, current: boolean) {
    setDocs((arr) => arr.map((d) => (d.id === id ? { ...d, includeByDefault: !current } : d)));
    await fetch(`/api/documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeByDefault: !current }),
    });
  }

  async function remove(id: string) {
    if (!confirm('Delete this document? Its summary will no longer be used in drafts.')) return;
    await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    setDocs((arr) => arr.filter((d) => d.id !== id));
    reload();
  }

  async function generatePatterns() {
    setGenState('running');
    setGenMsg('Analyzing your recent messages — this can take ~20s on a fresh run…');
    try {
      const r = await fetch('/api/patterns/generate', { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      const d = await r.json();
      setGenState('done');
      setGenMsg(`Generated from ${d.stats.total} messages (${d.stats.wins} wins, ${d.stats.duds} duds).`);
      reload();
      setTimeout(() => { setGenState('idle'); setGenMsg(''); }, 6000);
    } catch (e) {
      setGenState('error');
      setGenMsg(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function exportDoc(id: string) {
    const r = await fetch(`/api/documents/${id}`);
    if (!r.ok) return;
    const { document } = await r.json();
    const blob = new Blob([document.rawText ?? document.summary ?? ''], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const safe = document.title.replace(/[^a-z0-9-_ ]/gi, '').replace(/\s+/g, '-').slice(0, 80);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `${safe}.md`;
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <p className="text-[11.5px] text-[var(--color-text-tertiary)] -mt-1">
        Upload whitepapers, ICPs, case studies, pricing sheets — anything you want Claude to reference when drafting. Or generate a Winning Patterns playbook from your own outcome data. Summaries marked &ldquo;auto-include&rdquo; flow into every draft.
      </p>

      {/* Winning patterns generator */}
      <div className="card p-4 border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <p className="text-[13px] font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" />
              Winning Patterns playbook
            </p>
            <p className="text-[11.5px] text-[var(--color-text-tertiary)] mt-0.5 max-w-prose">
              Analyzes your last ~150 outbound messages with known outcomes, classifies wins vs duds via interest labels, and extracts patterns. Saved as a doc you can share with teammates.
            </p>
          </div>
          <button
            onClick={generatePatterns}
            disabled={genState === 'running'}
            className="press-feedback px-3 py-1.5 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white text-[12px] font-semibold rounded-md whitespace-nowrap inline-flex items-center gap-1.5"
            style={{ transition: 'all 140ms var(--ease-out-quart)' }}
          >
            {genState === 'running' ? 'Generating…' : <><Sparkles className="w-3.5 h-3.5" /> {patternsMeta?.lastGeneratedAt ? 'Re-generate' : 'Generate'}</>}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
          {patternsMeta?.windowEntry ? (
            <span>Analyzing your time at <span className="text-[var(--color-text-primary)] font-medium">{patternsMeta.windowEntry.company || '?'}</span>{patternsMeta.windowEntry.from && ` (since ${patternsMeta.windowEntry.from})`} — {patternsMeta.eligibleInWindow} eligible messages</span>
          ) : (
            <span>No employment dates set — analyzing all-time outbound. Add your LinkedIn URL in Your context to filter to your current role.</span>
          )}
          {patternsMeta?.lastGeneratedAt ? (
            <>
              <span>·</span>
              <span>Last run {formatDistanceToNowStrict(new Date(patternsMeta.lastGeneratedAt), { addSuffix: true })}</span>
              {patternsMeta.messagesSince > 0 && (
                <span className="text-[var(--color-accent)]">+{patternsMeta.messagesSince} new since</span>
              )}
            </>
          ) : (
            <>
              <span>·</span>
              <span>Never run yet</span>
            </>
          )}
          {genMsg && (
            <span className={cn(
              'w-full mt-0.5',
              genState === 'error' && 'text-[var(--color-danger)]',
              genState === 'done' && 'text-[var(--color-success)]',
              genState === 'running' && 'text-[var(--color-text-tertiary)]',
            )}>{genMsg}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowAdd(true)}
          className="press-feedback inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white text-[12px] font-semibold rounded-md"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          <Upload className="w-3.5 h-3.5" /> Add document
        </button>
      </div>

      {showAdd && <AddDocForm onClose={() => setShowAdd(false)} onAdded={reload} />}

      <div className="border-t border-[var(--color-hairline)] pt-3">
        {loading ? (
          <p className="text-[12px] text-[var(--color-text-tertiary)]">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="text-[12px] text-[var(--color-text-tertiary)] text-center py-4">
            No documents yet. Upload one or generate a Winning Patterns playbook above.
          </p>
        ) : (
          <div className="space-y-1">
            {docs.map((d) => (
              <DocRowItem
                key={d.id}
                doc={d}
                onToggle={() => toggleDefault(d.id, d.includeByDefault)}
                onDelete={() => remove(d.id)}
                onExport={() => exportDoc(d.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DocRowItem({ doc, onToggle, onDelete, onExport }: { doc: DocRow; onToggle: () => void; onDelete: () => void; onExport: () => void }) {
  const [open, setOpen] = useState(false);
  const isPatterns = doc.kind === 'winning-patterns';
  // Imported-from-teammate heuristic: source filename present + patterns kind
  const isImported = isPatterns && !!doc.sourceFilename;
  return (
    <div className={cn(
      'border rounded-lg overflow-hidden',
      isPatterns ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5' : 'border-[var(--color-hairline)]',
    )}>
      <div className="flex items-start gap-3 p-3">
        {isPatterns ? (
          <Star className="w-4 h-4 mt-0.5 text-[var(--color-accent)] flex-shrink-0 fill-[var(--color-accent)]/30" />
        ) : (
          <FileText className="w-4 h-4 mt-0.5 text-[var(--color-text-tertiary)] flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-semibold text-[var(--color-text-primary)] truncate">{doc.title}</span>
            <span className={cn(
              'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded',
              isPatterns
                ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                : 'bg-[var(--color-card-hover)] text-[var(--color-text-tertiary)]',
            )}>{doc.kind}</span>
            {isImported && (
              <span className="text-[10px] uppercase tracking-wide bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] px-1.5 py-0.5 rounded">imported</span>
            )}
          </div>
          {doc.sourceFilename && (
            <p className="text-[11px] text-[var(--color-text-tertiary)] truncate mt-0.5">{doc.sourceFilename}</p>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
          <span className="text-[11px] text-[var(--color-text-tertiary)]">auto-include</span>
          <button
            role="switch"
            aria-checked={doc.includeByDefault}
            onClick={onToggle}
            className={cn(
              'relative inline-flex h-5 w-9 items-center rounded-full transition-colors overflow-hidden',
              doc.includeByDefault ? 'bg-[var(--color-accent-deep)]' : 'bg-[var(--color-surface-2)]',
            )}
          >
            <span
              className={cn('inline-block h-3.5 w-3.5 transform rounded-full bg-white', doc.includeByDefault ? 'translate-x-5' : 'translate-x-1')}
              style={{ transition: 'transform var(--dur-medium) var(--ease-out-fluid)' }}
            />
          </button>
        </label>
        <button onClick={onExport} title="Export as .md" className="p-1.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)] rounded transition-colors flex-shrink-0">
          <Download className="w-3.5 h-3.5" />
        </button>
        <button onClick={onDelete} className="p-1.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 rounded transition-colors flex-shrink-0">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-card-hover)] border-t border-[var(--color-hairline)] flex items-center gap-1"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {open ? 'Hide summary' : 'View summary'}
      </button>
      {open && (
        <div className="px-4 py-3 bg-[var(--color-card-hover)] border-t border-[var(--color-hairline)] text-[12px] text-[var(--color-text-secondary)] whitespace-pre-wrap leading-relaxed">
          {doc.summary || <em className="text-[var(--color-text-tertiary)]">No summary stored.</em>}
        </div>
      )}
    </div>
  );
}

function AddDocForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('whitepaper');
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [pasteText, setPasteText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // When user picks a file or pastes text, peek for YAML frontmatter and
  // auto-fill kind + title (especially useful for teammate-shared patterns).
  async function onFileChosen(f: File | null) {
    setFile(f);
    setDetected(null);
    if (!f) return;
    if (f.type === 'application/pdf') return; // can't parse PDFs client-side
    try {
      const text = await fileToText(f);
      const { fields } = parseFrontmatter(text);
      if (fields.kind) {
        setKind(fields.kind);
        if (fields.kind === 'winning-patterns' && fields.author) {
          setTitle(`From ${fields.author} — Winning Patterns${fields.generatedAt ? ` (${fields.generatedAt.slice(0, 10)})` : ''}`);
          setDetected(`Detected: winning-patterns from ${fields.author}${fields.sampleSize ? `, n=${fields.sampleSize}` : ''}`);
        }
      }
    } catch {}
  }

  function onPasteChanged(text: string) {
    setPasteText(text);
    const { fields } = parseFrontmatter(text);
    if (fields.kind === 'winning-patterns' && fields.author) {
      setKind(fields.kind);
      setTitle(`From ${fields.author} — Winning Patterns${fields.generatedAt ? ` (${fields.generatedAt.slice(0, 10)})` : ''}`);
      setDetected(`Detected: winning-patterns from ${fields.author}${fields.sampleSize ? `, n=${fields.sampleSize}` : ''}`);
    } else {
      setDetected(null);
    }
  }

  async function upload() {
    setErr(null);
    if (!title.trim()) { setErr('Title is required'); return; }
    if (mode === 'file' && !file) { setErr('Choose a file'); return; }
    if (mode === 'paste' && !pasteText.trim()) { setErr('Paste some text'); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { title: title.trim(), kind };
      if (mode === 'file' && file) {
        if (file.type === 'application/pdf') {
          body.fileBase64 = await fileToBase64(file);
          body.fileMime = 'application/pdf';
        } else {
          body.rawText = await fileToText(file);
        }
        body.sourceFilename = file.name;
        body.sourceMime = file.type || null;
      } else {
        body.rawText = pasteText;
      }
      const r = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `HTTP ${r.status}`);
      }
      onAdded();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4 space-y-3 border border-[var(--color-accent)]/30">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Bedrock 2026 ICP Brief"
            className="input w-full"
          />
        </div>
        <div>
          <label className="block text-[12px] font-semibold text-[var(--color-text-primary)] mb-1">Kind</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="input w-full">
            {KIND_PRESETS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      </div>

      <div className="flex gap-2 text-[11px]">
        <button
          onClick={() => setMode('file')}
          className={cn('px-2 py-1 rounded', mode === 'file' ? 'bg-[var(--color-accent-deep)] text-white' : 'bg-[var(--color-card-hover)] text-[var(--color-text-tertiary)]')}
        >
          Upload file
        </button>
        <button
          onClick={() => setMode('paste')}
          className={cn('px-2 py-1 rounded', mode === 'paste' ? 'bg-[var(--color-accent-deep)] text-white' : 'bg-[var(--color-card-hover)] text-[var(--color-text-tertiary)]')}
        >
          Paste text
        </button>
      </div>

      {mode === 'file' ? (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
            onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full px-3 py-2 border border-dashed border-[var(--color-hairline)] rounded-lg text-[12px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-card-hover)]"
          >
            {file ? <span className="text-[var(--color-text-primary)]">{file.name} ({Math.round(file.size / 1024)} KB)</span> : 'Choose .pdf, .txt, or .md…'}
          </button>
        </div>
      ) : (
        <textarea
          value={pasteText}
          onChange={(e) => onPasteChanged(e.target.value)}
          rows={6}
          placeholder="Paste the document text here…"
          className="input w-full resize-y"
        />
      )}

      {detected && <p className="text-[11px] text-[var(--color-accent)]">{detected}</p>}
      {err && <p className="text-[11px] text-[var(--color-danger)]">{err}</p>}

      <div className="flex gap-2">
        <button
          onClick={upload}
          disabled={busy}
          className="px-3 py-1.5 bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white text-[12px] font-semibold rounded-md inline-flex items-center gap-1"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          {busy ? 'Uploading…' : <><Check className="w-3.5 h-3.5" /> Upload & summarize</>}
        </button>
        <button
          onClick={onClose}
          disabled={busy}
          className="px-3 py-1.5 border border-[var(--color-hairline)] text-[var(--color-text-tertiary)] text-[12px] rounded-md hover:bg-[var(--color-card-hover)] inline-flex items-center gap-1"
        >
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
      </div>
    </div>
  );
}
