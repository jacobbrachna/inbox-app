'use client';
import { useState, useRef } from 'react';
import { Upload, Check, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

// Reads LinkedIn's Connections.csv (or a .zip containing it) and posts it
// to /api/import/linkedin-connections for bulk matching + enrichment.

export function LinkedInImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'reading' | 'sending' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState<{ rowsParsed: number; contactsMatched: number; contactsEnriched: number; contactsUpserted?: number } | null>(null);

  async function handleFile(file: File) {
    setState('reading');
    setMsg(`Reading ${file.name}…`);
    setResult(null);

    let csv: string;
    try {
      if (file.name.toLowerCase().endsWith('.zip')) {
        // Extract Connections.csv from the LinkedIn ZIP. We use the browser's
        // built-in DecompressionStream — supported in all modern Chromes.
        csv = await extractConnectionsFromZip(file);
      } else {
        csv = await file.text();
      }
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : 'Failed to read file');
      return;
    }

    setState('sending');
    setMsg('Matching against your contacts…');
    try {
      const r = await fetch('/api/import/linkedin-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setState('done');
      setResult(data);
      setMsg('');
    } catch (e) {
      setState('error');
      setMsg(e instanceof Error ? e.message : 'Import failed');
    }
  }

  function onPick() { inputRef.current?.click(); }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = '';
  }

  return (
    <div>
      <p className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-1">
        Import LinkedIn connections export
      </p>
      <p className="text-[11.5px] text-[var(--color-text-tertiary)] mb-3">
        Request your data at{' '}
        <a
          href="https://www.linkedin.com/psettings/member-data"
          target="_blank" rel="noopener noreferrer"
          className="text-[var(--color-accent)] hover:text-[var(--color-accent-deep)]"
        >
          linkedin.com/psettings/member-data
        </a>
        {' '}(pick &ldquo;Connections&rdquo; only — arrives in ~10–30 min). Drop the resulting{' '}
        <code className="mono bg-[var(--color-surface-2)] px-1 py-0.5 rounded text-[10px]">Connections.csv</code>{' '}
        (or the full zip) here. Verified URLs + company + role override any scraped data.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.zip,application/zip,text/csv"
        onChange={onChange}
        style={{ display: 'none' }}
      />

      <div className="flex items-center gap-3">
        <button
          onClick={onPick}
          disabled={state === 'reading' || state === 'sending'}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold',
            'bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          <Upload className="w-3.5 h-3.5" />
          {state === 'reading' ? 'Reading…' : state === 'sending' ? 'Importing…' : 'Choose file'}
        </button>

        {msg && (
          <span className={cn(
            'text-[11px]',
            state === 'error' && 'text-[var(--color-danger)] inline-flex items-center gap-1',
            (state === 'reading' || state === 'sending') && 'text-[var(--color-text-tertiary)]',
          )}>
            {state === 'error' && <AlertCircle className="w-3 h-3" />}
            {msg}
          </span>
        )}
      </div>

      {state === 'done' && result && (
        <div className="mt-3 p-3 rounded-lg bg-[var(--color-success)]/10 border border-[var(--color-success)]/30">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--color-success)] mb-1">
            <Check className="w-3.5 h-3.5" /> Imported
          </div>
          <div className="text-[11.5px] text-[var(--color-text-secondary)] leading-relaxed">
            Parsed <strong>{result.rowsParsed.toLocaleString()}</strong> connections.
            {typeof result.contactsUpserted === 'number' && (
              <> Saved <strong>{result.contactsUpserted.toLocaleString()}</strong> to your contacts.</>
            )}
            {' '}Linked URLs to <strong>{result.contactsMatched.toLocaleString()}</strong> conversation
            {result.contactsMatched === 1 ? '' : 's'} ·
            updated company/role on <strong>{result.contactsEnriched.toLocaleString()}</strong>.
          </div>
        </div>
      )}
    </div>
  );
}

// Browser-native ZIP extraction. Reads the LinkedIn export zip and returns the
// text content of Connections.csv. No third-party dependency — uses the
// well-known ZIP "stored" (no compression) or "deflate" (DecompressionStream).
async function extractConnectionsFromZip(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());

  // Find the central directory by scanning backwards for the End Of Central
  // Directory signature (0x06054b50). LinkedIn's exports don't have a ZIP64
  // trailer so the standard locator is sufficient.
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Not a ZIP file (no EOCD)');

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cdEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // Walk the central directory looking for Connections.csv
  let ptr = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('Bad CD signature');
    const compMethod = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompSize = view.getUint32(ptr + 24, true);
    const fnameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const filename = new TextDecoder().decode(buf.slice(ptr + 46, ptr + 46 + fnameLen));

    if (filename.endsWith('Connections.csv') || filename === 'Connections.csv') {
      // Read the local file header to find data offset
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) throw new Error('Bad local header');
      const lhFnameLen = view.getUint16(localHeaderOffset + 26, true);
      const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + lhFnameLen + lhExtraLen;
      const compressed = buf.slice(dataStart, dataStart + compSize);

      if (compMethod === 0) {
        // Stored (uncompressed)
        return new TextDecoder().decode(compressed);
      }
      if (compMethod === 8) {
        // Deflate
        const stream = new Blob([compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer]).stream();
        const decompressed = stream.pipeThrough(new DecompressionStream('deflate-raw'));
        const reader = decompressed.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
        return new TextDecoder().decode(merged);
      }
      throw new Error(`Unsupported compression method ${compMethod}`);
    }

    ptr += 46 + fnameLen + extraLen + commentLen;
  }
  throw new Error('Connections.csv not found in ZIP');
}
