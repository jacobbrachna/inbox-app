'use client';
import { useState, useEffect } from 'react';
import { Plus, Trash2, Check, X } from 'lucide-react';
import { useStore, useAuthStore } from '@/store';
import type { Snippet } from '@/types';
import { Badge } from '@/components/shared/badge';
import { useExtensionReady } from '@/lib/use-extension-ready';
import { cn } from '@/lib/cn';
import { AccentPicker } from '@/components/theme/accent-picker';
import { AiSettings } from './ai-settings';
import { YourContext } from './your-context';
import { DocumentsPanel } from './documents-panel';
import { LinkedInImport } from './linkedin-import';


function RecoverButton() {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [logLines, setLogLines] = useState<string[]>([]);
  const bridgeReady = useExtensionReady();

  function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
    const time = new Date().toLocaleTimeString();
    const prefix = level === 'error' ? '✗ ' : level === 'warn' ? '⚠ ' : '· ';
    setLogLines((lines) => [...lines.slice(-200), `[${time}] ${prefix}${msg}`]);
  }

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type === 'inboxpro-refresh-progress') {
        log(ev.data.message);
      }
      if (ev.data.type === 'inboxpro-recover-result') {
        const r = ev.data.response;
        if (r?.ok) {
          setState('done');
          log(`Done. Recovered ${r.recovered} of ${r.total} threads`, 'info');
        } else {
          setState('error');
          log(`Failed: ${r?.reason ?? 'unknown'}`, 'error');
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  function start() {
    setState('running');
    setLogLines([]);
    log('Starting recovery…');

    fetch('/api/conversations/sparse')
      .then((r) => r.json())
      .then((d) => {
        const n = Array.isArray(d.ids) ? d.ids.length : 0;
        log(`Backend reports ${n} conversations need recovery`);
      })
      .catch((e) => log(`Backend check failed: ${e.message}`, 'error'));

    // Watchdog: track if ANY extension message has arrived
    let extensionResponded = false;
    function onAny(ev: MessageEvent) {
      if (ev.data?.type === 'inboxpro-refresh-progress' || ev.data?.type === 'inboxpro-recover-result') {
        extensionResponded = true;
      }
    }
    window.addEventListener('message', onAny);
    setTimeout(() => {
      window.removeEventListener('message', onAny);
      if (!extensionResponded) {
        log('No response from extension after 8s.', 'warn');
        log('Try: chrome://extensions → reload InboxPro → hard-refresh this page.', 'warn');
      }
    }, 8000);

    window.postMessage({ type: 'inboxpro-recover-request' }, '*');
  }

  function copyLog() {
    navigator.clipboard.writeText(logLines.join('\n')).catch(() => {});
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          onClick={start}
          disabled={state === 'running'}
          className="px-3 py-2 bg-[var(--color-accent-deep)] text-white text-[12px] font-semibold rounded-lg hover:bg-[var(--color-accent)] disabled:opacity-50"
        >
          {state === 'running' ? 'Recovering…' : 'Recover missing threads'}
        </button>
        {logLines.length > 0 && (
          <button
            onClick={copyLog}
            className="px-3 py-2 bg-[var(--color-card-hover)] text-[var(--color-text-secondary)] text-[11px] font-medium rounded-lg hover:bg-[var(--color-surface-2)]"
          >
            Copy log
          </button>
        )}
        {!bridgeReady && (
          <span className="text-xs text-[var(--color-accent)]">⚠ Extension not detected on this page</span>
        )}
      </div>
      {logLines.length > 0 && (
        <div className="mt-3 bg-black/40 border border-[var(--color-hairline)] rounded-lg p-3 max-h-64 overflow-y-auto font-mono text-xs text-[var(--color-text-secondary)] leading-relaxed">
          {logLines.map((l, i) => (
            <div key={i} className={cn(
              l.includes('✗') && 'text-[var(--color-danger)]',
              l.includes('⚠') && 'text-[var(--color-accent)]',
            )}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function SnippetRow({ snippet, onDelete }: { snippet: Snippet; onDelete: () => void }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-[var(--color-hairline)] last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{snippet.name}</span>
          <code className="text-xs bg-[var(--color-card-hover)] text-[var(--color-text-tertiary)] px-1.5 py-0.5 rounded font-mono">{snippet.shortcut}</code>
        </div>
        <p className="text-xs text-[var(--color-text-tertiary)] line-clamp-2">{snippet.body}</p>
      </div>
      <button onClick={onDelete} className="p-1.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 rounded-lg transition-colors flex-shrink-0">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function SettingsPanel() {
  const { snippets, addSnippet, removeSnippet, labels, addLabel, removeLabel } = useStore();
  const mirrorToLinkedIn = useAuthStore((s) => s.mirrorToLinkedIn);
  const setMirrorToLinkedIn = useAuthStore((s) => s.setMirrorToLinkedIn);
  const [newSnippet, setNewSnippet] = useState({ name: '', shortcut: '', body: '' });
  const [addingSnippet, setAddingSnippet] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState('#3b82f6');

  function saveSnippet() {
    if (!newSnippet.name || !newSnippet.shortcut || !newSnippet.body) return;
    addSnippet({ id: Date.now().toString(), ...newSnippet });
    setNewSnippet({ name: '', shortcut: '', body: '' });
    setAddingSnippet(false);
  }

  function saveLabel() {
    if (!newLabelName.trim()) return;
    addLabel({ id: newLabelName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(), name: newLabelName, color: newLabelColor });
    setNewLabelName('');
  }

  const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280'];

  return (
    <div className="card flex-1 overflow-y-auto p-6 max-w-4xl">
      <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-text-primary)] mb-6">Settings</h2>

      {/* Appearance */}
      <section className="mb-8">
        <h3 className="eyebrow mb-3">Appearance</h3>
        <div className="card p-5">
          <p className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-1">Accent color</p>
          <p className="text-[12px] text-[var(--color-text-tertiary)] mb-4">
            Used for active rows, primary buttons, outbound message bubbles.
          </p>
          <AccentPicker />
        </div>
      </section>

      {/* AI */}
      <section className="mb-8">
        <h3 className="eyebrow mb-3">AI</h3>
        <div className="card p-5">
          <AiSettings />
        </div>
      </section>

      {/* Your context — fuels AI personalization */}
      <section className="mb-8">
        <h3 className="eyebrow mb-3">Your context</h3>
        <div className="card p-5">
          <YourContext />
        </div>
      </section>

      {/* Reference documents */}
      <section className="mb-8">
        <h3 className="eyebrow mb-3">Reference documents</h3>
        <div className="card p-5">
          <DocumentsPanel />
        </div>
      </section>

      {/* LinkedIn data import */}
      <section className="mb-8">
        <h3 className="eyebrow mb-3">LinkedIn data</h3>
        <div className="card p-5">
          <LinkedInImport />
        </div>
      </section>

      {/* Sync */}
      <section className="mb-8">
        <h3 className="eyebrow mb-3">Sync</h3>
        <div className="card p-5">
          <p className="text-sm text-[var(--color-text-tertiary)] mb-1">
            InboxPro auto-syncs in the background every 5 minutes (and passively while you have LinkedIn open).
          </p>
          <p className="text-xs text-[var(--color-text-tertiary)] mb-4">
            Use the refresh button in the inbox header for an on-demand pull. To rebuild from scratch, use the recovery tool below.
          </p>
          <details className="text-sm">
            <summary className="text-xs text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-tertiary)]">Advanced: rebuild missing message history</summary>
            <div className="mt-3">
              <RecoverButton />
            </div>
          </details>
        </div>
      </section>

      {/* Mirror to LinkedIn */}
      <section className="mb-8">
        <h3 className="eyebrow mb-3">Mirror actions to LinkedIn</h3>
        <div className="card p-5">
          <label className="flex items-start justify-between gap-4 cursor-pointer">
            <div>
              <p className="text-sm font-semibold text-[var(--color-text-primary)]">Two-way sync</p>
              <p className="text-xs text-[var(--color-text-tertiary)] mt-1 max-w-md">
                When enabled, actions in InboxPro (delete, archive, star, mark read/unread) also fire on LinkedIn. Disable for local-only changes.
              </p>
              {mirrorToLinkedIn && (
                <p className="text-xs text-[var(--color-accent)] mt-2">
                  ⚠ Deletion on LinkedIn is permanent and can&apos;t be undone.
                </p>
              )}
            </div>
            <button
              role="switch"
              aria-checked={mirrorToLinkedIn}
              onClick={() => setMirrorToLinkedIn(!mirrorToLinkedIn)}
              className={cn(
                'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full overflow-hidden',
                mirrorToLinkedIn ? 'bg-[var(--color-accent-deep)]' : 'bg-[var(--color-surface-2)]',
              )}
              style={{ transition: 'background-color var(--dur-medium) var(--ease-out-soft)' }}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 transform rounded-full bg-white',
                  mirrorToLinkedIn ? 'translate-x-6' : 'translate-x-1',
                )}
                style={{ transition: 'transform var(--dur-medium) var(--ease-out-fluid)' }}
              />
            </button>
          </label>
        </div>
      </section>

      {/* Labels */}
      <section className="mb-8">
        <h3 className="eyebrow mb-3">Labels</h3>
        <div className="card p-4">
          <div className="flex flex-wrap gap-2 mb-3">
            {labels.map((l) => (
              <Badge
                key={l.id}
                label={l.name}
                color={l.color}
                onRemove={() => removeLabel(l.id)}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <div className="flex gap-1">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  className="w-5 h-5 rounded-full border-2 transition-all"
                  style={{ backgroundColor: c, borderColor: newLabelColor === c ? c : 'transparent' }}
                  onClick={() => setNewLabelColor(c)}
                />
              ))}
            </div>
            <input
              type="text"
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveLabel()}
              placeholder="Label name…"
              className="input flex-1"
            />
            <button onClick={saveLabel} className="px-3 py-1.5 bg-[var(--color-accent-deep)] text-white text-sm rounded-lg hover:bg-[var(--color-accent)]">
              Add
            </button>
          </div>
        </div>
      </section>

      {/* Snippets */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="eyebrow">Message Snippets</h3>
          <button
            onClick={() => setAddingSnippet(true)}
            className="flex items-center gap-1.5 text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-deep)] font-medium"
          >
            <Plus className="w-3.5 h-3.5" /> New Snippet
          </button>
        </div>
        <div className="card p-4">
          {addingSnippet && (
            <div className="mb-4 space-y-2 pb-4 border-b border-[var(--color-hairline)]">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newSnippet.name}
                  onChange={(e) => setNewSnippet((s) => ({ ...s, name: e.target.value }))}
                  placeholder="Name (e.g. Introduction)"
                  className="input flex-1"
                />
                <input
                  type="text"
                  value={newSnippet.shortcut}
                  onChange={(e) => setNewSnippet((s) => ({ ...s, shortcut: e.target.value }))}
                  placeholder="/shortcut"
                  className="input w-28 font-mono"
                />
              </div>
              <textarea
                value={newSnippet.body}
                onChange={(e) => setNewSnippet((s) => ({ ...s, body: e.target.value }))}
                placeholder="Message body… use {{name}}, {{company}} for variables"
                rows={3}
                className="input w-full resize-none"
              />
              <div className="flex gap-2">
                <button onClick={saveSnippet} className="px-3 py-1.5 bg-[var(--color-accent-deep)] text-white text-sm rounded-lg hover:bg-[var(--color-accent)] flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> Save
                </button>
                <button onClick={() => setAddingSnippet(false)} className="px-3 py-1.5 border border-[var(--color-hairline)] text-[var(--color-text-tertiary)] text-sm rounded-lg hover:bg-[var(--color-card-hover)] flex items-center gap-1">
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
              </div>
            </div>
          )}
          {snippets.length === 0 && !addingSnippet ? (
            <p className="text-sm text-[var(--color-text-tertiary)] text-center py-4">No snippets yet — add one to speed up your replies</p>
          ) : (
            snippets.map((s) => (
              <SnippetRow key={s.id} snippet={s} onDelete={() => removeSnippet(s.id)} />
            ))
          )}
        </div>
      </section>

      {/* Keyboard shortcuts */}
      <section>
        <h3 className="eyebrow mb-3">Keyboard Shortcuts</h3>
        <div className="card p-4">
          {[
            ['⌘↵', 'Send message'],
            ['S', 'Star / unstar conversation'],
            ['E', 'Archive conversation'],
            ['H', 'Snooze conversation'],
            ['/', 'Search'],
            ['⌘K', 'Command palette (coming soon)'],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between py-1.5 border-b border-[var(--color-hairline)] last:border-0">
              <span className="text-sm text-[var(--color-text-tertiary)]">{desc}</span>
              <kbd className="bg-[var(--color-card-hover)] border border-[var(--color-hairline)] text-[var(--color-text-secondary)] text-xs px-2 py-0.5 rounded font-mono shadow-sm">{key}</kbd>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
