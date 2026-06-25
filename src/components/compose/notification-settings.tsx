'use client';
import { useEffect, useState, Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import {
  DEFAULT_NOTIFICATION_PREFS, NOTIFY_TYPE_META,
  type NotificationPrefs, type NotifyType,
} from '@/lib/notification-prefs';

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-9 h-5 rounded-full flex-shrink-0',
        checked ? 'bg-[var(--color-accent-deep)]' : 'bg-[var(--color-surface-2)]',
      )}
      style={{ transition: 'background-color 160ms var(--ease-out-quart)' }}
    >
      <span
        className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm', checked && 'translate-x-4')}
        style={{ transition: 'transform 160ms var(--ease-out-quart)' }}
      />
    </button>
  );
}

function Check({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'w-4 h-4 rounded border flex items-center justify-center',
        checked
          ? 'bg-[var(--color-accent-deep)] border-[var(--color-accent-deep)] text-white'
          : 'border-[var(--color-hairline)] bg-[var(--color-card)] text-transparent hover:border-[var(--color-text-tertiary)]',
      )}
      style={{ transition: 'all 140ms var(--ease-out-quart)' }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
    </button>
  );
}

function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--color-text-primary)]">{label}</div>
        {desc && <div className="text-[11.5px] text-[var(--color-text-tertiary)]">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/notifications/prefs')
      .then((r) => r.json())
      .then((d) => setPrefs(d.prefs ?? DEFAULT_NOTIFICATION_PREFS))
      .catch(() => setPrefs(DEFAULT_NOTIFICATION_PREFS));
  }, []);

  function save(next: NotificationPrefs) {
    setPrefs(next);
    fetch('/api/notifications/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: next }),
    })
      .then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); })
      .catch(() => {});
  }

  function setType(key: NotifyType, channel: 'bell' | 'desktop', v: boolean) {
    if (!prefs) return;
    save({ ...prefs, types: { ...prefs.types, [key]: { ...prefs.types[key], [channel]: v } } });
  }

  function sendTest() {
    setTestMsg(null);
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setTestMsg('This browser doesn’t support desktop notifications.');
      return;
    }
    if (Notification.permission === 'denied') {
      setTestMsg('Notifications are blocked in your browser settings.');
      return;
    }
    if (Notification.permission !== 'granted') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') sendTest();
        else setTestMsg('Allow notifications to test them.');
      });
      return;
    }
    try {
      new Notification('Relay test notification', {
        body: 'Your desktop notifications are working.',
        silent: !(prefs?.sound ?? true),
      });
      setTestMsg('Sent! Check your desktop.');
      setTimeout(() => setTestMsg(null), 2500);
    } catch {
      setTestMsg('Couldn’t fire a test notification.');
    }
  }

  if (!prefs) {
    return <div className="text-[12px] text-[var(--color-text-tertiary)]">Loading…</div>;
  }

  const masterOff = !prefs.enabled;

  return (
    <div className="space-y-6">
      {/* Global */}
      <div className="space-y-3">
        <Row label="Desktop notifications" desc="Master switch for all OS pings. The in-app bell still works.">
          <Toggle checked={prefs.enabled} onChange={(v) => save({ ...prefs, enabled: v })} />
        </Row>
        <Row label="Play sound" desc="Play a sound with desktop pings.">
          <Toggle checked={prefs.sound} onChange={(v) => save({ ...prefs, sound: v })} />
        </Row>
        <Row label="Quiet hours" desc="Silence desktop pings during a daily window. They still collect in the bell.">
          <Toggle checked={prefs.quietHours.enabled} onChange={(v) => save({ ...prefs, quietHours: { ...prefs.quietHours, enabled: v } })} />
        </Row>
        {prefs.quietHours.enabled && (
          <div className="flex items-center gap-4 pl-1 text-[12px] text-[var(--color-text-secondary)]">
            <label className="flex items-center gap-2">From
              <input
                type="time"
                value={prefs.quietHours.start}
                onChange={(e) => save({ ...prefs, quietHours: { ...prefs.quietHours, start: e.target.value } })}
                className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-md px-2 py-1 text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <label className="flex items-center gap-2">To
              <input
                type="time"
                value={prefs.quietHours.end}
                onChange={(e) => save({ ...prefs, quietHours: { ...prefs.quietHours, end: e.target.value } })}
                className="bg-[var(--color-surface)] border border-[var(--color-hairline)] rounded-md px-2 py-1 text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
            </label>
          </div>
        )}
      </div>

      {/* Per-type matrix */}
      <div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-5 gap-y-3 items-center">
          <div className="eyebrow text-[10px]">By type</div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)] text-center w-10">Bell</div>
          <div className={cn('text-[10px] uppercase tracking-wide text-center w-12', masterOff ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-tertiary)]')}>Desktop</div>
          {NOTIFY_TYPE_META.map((t) => (
            <Fragment key={t.key}>
              <div className="min-w-0">
                <div className="text-[12.5px] text-[var(--color-text-primary)]">{t.label}</div>
                <div className="text-[11px] text-[var(--color-text-tertiary)]">{t.desc}</div>
              </div>
              <div className="flex justify-center w-10">
                {t.bellNA
                  ? <span className="text-[var(--color-text-muted)] text-[12px]">—</span>
                  : <Check checked={prefs.types[t.key].bell} onChange={(v) => setType(t.key, 'bell', v)} />}
              </div>
              <div className={cn('flex justify-center w-12', masterOff && 'opacity-40 pointer-events-none')}>
                <Check checked={prefs.types[t.key].desktop} onChange={(v) => setType(t.key, 'desktop', v)} />
              </div>
            </Fragment>
          ))}
        </div>
        {masterOff && (
          <p className="text-[11px] text-[var(--color-text-tertiary)] mt-3">Desktop pings are off (master switch). Turn it on to use the per-type desktop toggles.</p>
        )}
      </div>

      {/* Test */}
      <div className="flex items-center gap-3">
        <button
          onClick={sendTest}
          className="text-[12px] font-medium px-3 py-1.5 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-primary)] hover:bg-[var(--color-card-hover)]"
          style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
        >
          Send test notification
        </button>
        {testMsg && <span className="text-[11px] text-[var(--color-text-secondary)]">{testMsg}</span>}
        {saved && !testMsg && <span className="text-[11px] text-[var(--color-success)]">Saved</span>}
      </div>
    </div>
  );
}
