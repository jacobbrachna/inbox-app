'use client';
import { useEffect } from 'react';

// Replaces the old localhost-only content-script bridge (extension/bridge.js).
//
// Connects to the Electron main process's WebSocket broker at
// ws://127.0.0.1:3030/ws and shuttles messages between the app and the
// extension's background service worker:
//
//   - Outgoing: any `window.postMessage` event whose `type` begins with
//     `relay-` is forwarded over the socket. Existing app components
//     keep calling `window.postMessage(...)` exactly like before.
//   - Incoming: every WS frame from the extension is re-emitted as a
//     `window.postMessage` event so existing listeners (refresh, sync,
//     notifications, etc.) see the same `{ type, ... }` shape.
//
// The broker also sends `{ type: 'presence', extensionConnected }` so the
// app knows when the extension is connected. We translate that into the
// same `relay-bridge-ready` event + `relay-bridge-marker` meta
// element that bridge.js used to inject — so `useExtensionReady()` keeps
// working unchanged.
const WS_URL = 'ws://127.0.0.1:3030/ws';
const MARKER_ID = 'relay-bridge-marker';

function ensureMarker(connected: boolean) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(MARKER_ID);
  if (connected) {
    if (!existing) {
      const m = document.createElement('meta');
      m.id = MARKER_ID;
      m.setAttribute('content', 'ready');
      (document.head || document.documentElement).appendChild(m);
      window.postMessage({ type: 'relay-bridge-ready' }, '*');
    }
  } else if (existing) {
    existing.remove();
  }
}

// While the app window is open, poll the extension every 10s to mirror
// what bridge.js did on the legacy localhost page. Two separate cadences
// (LinkedIn + SN) — without these, in-app users would wait the full 3–5
// minute chrome.alarms tick to see new inbound messages.
const POLL_LI_INTERVAL_MS = 10_000;
const POLL_SN_INTERVAL_MS = 10_000;

export function WsBridge() {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let backoff = 500;
    let liPollTimer: ReturnType<typeof setInterval> | null = null;
    let snPollTimer: ReturnType<typeof setInterval> | null = null;
    let extensionConnected = false;

    function send(payload: unknown) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(payload)); } catch {}
      }
    }

    function startPolling() {
      stopPolling();
      // Stagger by 2s so the two polls aren't synchronized.
      liPollTimer = setInterval(() => {
        send({ type: 'relay-refresh-request', silent: true });
      }, POLL_LI_INTERVAL_MS);
      setTimeout(() => {
        snPollTimer = setInterval(() => {
          send({ type: 'relay-sn-refresh-request' });
        }, POLL_SN_INTERVAL_MS);
      }, 2000);
    }
    function stopPolling() {
      if (liPollTimer) { clearInterval(liPollTimer); liPollTimer = null; }
      if (snPollTimer) { clearInterval(snPollTimer); snPollTimer = null; }
    }

    function postOutbound(ev: MessageEvent) {
      if (ev.source !== window || !ev.data || typeof ev.data !== 'object') return;
      const t = ev.data.type;
      if (typeof t !== 'string' || !t.startsWith('relay-')) return;
      // Don't echo our own re-emitted incoming messages back to the wire.
      if (ev.data.__fromExtension) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(ev.data)); } catch {}
      }
    }

    function connect() {
      if (closed) return;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 5000);
        return;
      }
      ws.addEventListener('open', () => {
        backoff = 500;
        ws!.send(JSON.stringify({ type: '__hello', role: 'renderer' }));
      });
      ws.addEventListener('close', () => {
        ensureMarker(false);
        if (!closed) setTimeout(connect, backoff = Math.min(backoff * 2, 5000));
      });
      ws.addEventListener('error', () => { try { ws!.close(); } catch {} });
      ws.addEventListener('message', (ev) => {
        let msg: { type?: string; extensionConnected?: boolean; [k: string]: unknown };
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'presence') {
          const connected = !!msg.extensionConnected;
          ensureMarker(connected);
          if (connected && !extensionConnected) startPolling();
          if (!connected && extensionConnected) stopPolling();
          extensionConnected = connected;
          return;
        }
        if (typeof msg.type === 'string' && msg.type.startsWith('relay-')) {
          // Re-emit as a window message so existing listeners see it.
          window.postMessage({ ...msg, __fromExtension: true }, '*');
        }
      });
    }

    window.addEventListener('message', postOutbound);
    connect();
    return () => {
      closed = true;
      stopPolling();
      window.removeEventListener('message', postOutbound);
      try { ws?.close(); } catch {}
    };
  }, []);
  return null;
}
