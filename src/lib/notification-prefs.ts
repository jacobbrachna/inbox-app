// Notification preferences — shared model + gating helpers used by the in-app
// bell, the desktop/OS pings, and (mirrored in JS) the extension's alerts.

export type NotifyType =
  | 'new-message'
  | 'ai-signal'
  | 'follow-up-due'
  | 'job-change'
  | 'parser-health'
  | 'system';

export interface TypePref { bell: boolean; desktop: boolean }

export interface NotificationPrefs {
  enabled: boolean;                 // master switch for desktop/OS pings
  sound: boolean;                   // play sound on desktop pings
  quietHours: { enabled: boolean; start: string; end: string }; // "HH:MM"
  types: Record<NotifyType, TypePref>;
}

// Display metadata for the settings matrix (label + description, ordered).
export const NOTIFY_TYPE_META: { key: NotifyType; label: string; desc: string; bellNA?: boolean }[] = [
  { key: 'new-message', label: 'New message', desc: 'An inbound message lands in a known conversation.' },
  { key: 'ai-signal', label: 'AI signal', desc: 'AI flags interest, a booked meeting, or other positive signal.' },
  { key: 'follow-up-due', label: 'Follow-up due', desc: 'A follow-up you committed to (or AI detected) comes due.' },
  { key: 'job-change', label: 'Job change', desc: 'A contact changed company or role.' },
  { key: 'parser-health', label: 'Parser health', desc: 'LinkedIn changed shape and a scraper is failing (extension only).', bellNA: true },
  { key: 'system', label: 'System', desc: 'General Relay notices + test notifications.' },
];

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  sound: true,
  quietHours: { enabled: false, start: '20:00', end: '08:00' },
  types: {
    'new-message': { bell: true, desktop: true },
    'ai-signal': { bell: true, desktop: true },
    'follow-up-due': { bell: true, desktop: true },
    'job-change': { bell: true, desktop: false },
    'parser-health': { bell: false, desktop: true },
    'system': { bell: true, desktop: true },
  },
};

// Parse stored JSON into a fully-populated prefs object (missing fields fall
// back to defaults, so older/partial blobs stay valid).
export function parseNotificationPrefs(raw: string | null | undefined): NotificationPrefs {
  if (!raw) return DEFAULT_NOTIFICATION_PREFS;
  let p: Record<string, unknown>;
  try { p = JSON.parse(raw); } catch { return DEFAULT_NOTIFICATION_PREFS; }
  const q = (p.quietHours ?? {}) as Record<string, unknown>;
  const inTypes = (p.types ?? {}) as Record<string, Partial<TypePref>>;
  const types = { ...DEFAULT_NOTIFICATION_PREFS.types };
  for (const k of Object.keys(types) as NotifyType[]) {
    types[k] = {
      bell: inTypes[k]?.bell ?? types[k].bell,
      desktop: inTypes[k]?.desktop ?? types[k].desktop,
    };
  }
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : true,
    sound: typeof p.sound === 'boolean' ? p.sound : true,
    quietHours: {
      enabled: typeof q.enabled === 'boolean' ? q.enabled : false,
      start: typeof q.start === 'string' ? q.start : '20:00',
      end: typeof q.end === 'string' ? q.end : '08:00',
    },
    types,
  };
}

export function inQuietHours(prefs: NotificationPrefs, d: Date = new Date()): boolean {
  if (!prefs.quietHours.enabled) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const now = d.getHours() * 60 + d.getMinutes();
  const start = toMin(prefs.quietHours.start);
  const end = toMin(prefs.quietHours.end);
  if (start === end) return false;
  return start < end ? (now >= start && now < end) : (now >= start || now < end);
}

// Should a desktop/OS ping fire for this kind right now?
export function shouldDesktop(prefs: NotificationPrefs, kind: string, d: Date = new Date()): boolean {
  if (!prefs.enabled) return false;
  if (inQuietHours(prefs, d)) return false;
  const t = prefs.types[kind as NotifyType];
  return t ? t.desktop : true;
}

// Should this kind appear in the in-app bell feed / unread count?
export function shouldBell(prefs: NotificationPrefs, kind: string): boolean {
  const t = prefs.types[kind as NotifyType];
  return t ? t.bell : true;
}
