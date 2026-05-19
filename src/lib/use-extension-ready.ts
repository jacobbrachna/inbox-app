'use client';
import { useEffect, useState } from 'react';

const MARKER_ID = 'relay-bridge-marker';

// One MutationObserver per page lifecycle. Cheaper than every consumer
// running a 1s setInterval poll. We attach to document.body once and
// fan out to every subscriber with the current ready state.
let observer: MutationObserver | null = null;
let ready = false;
const subscribers = new Set<(ready: boolean) => void>();

function check(): boolean {
  return typeof document !== 'undefined' && !!document.getElementById(MARKER_ID);
}

function notify(next: boolean) {
  if (next === ready) return;
  ready = next;
  subscribers.forEach((cb) => cb(ready));
}

function ensureObserver() {
  if (observer || typeof document === 'undefined') return;
  ready = check();
  // Primary signal: the bridge announces itself via postMessage on load.
  // This fires synchronously after the marker is appended.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.type === 'relay-bridge-ready') notify(true);
  });
  // Fallback: watch <head> for the marker append (childList only — cheap).
  // Handles the case where the marker was injected before we mounted but
  // somehow disappeared, or where we missed the postMessage.
  const attach = () => {
    const target = document.head || document.documentElement;
    observer = new MutationObserver(() => notify(check()));
    observer.observe(target, { childList: true });
  };
  if (document.head) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
}

/**
 * Returns true once the Relay Chrome extension has injected its bridge
 * marker into the page. A single MutationObserver watches document.body —
 * every call site subscribes to the same source instead of polling.
 */
export function useExtensionReady(): boolean {
  // Start false on both server and client so the initial markup matches
  // and hydration doesn't error. The mount effect then syncs to truth.
  const [isReady, setIsReady] = useState<boolean>(false);

  useEffect(() => {
    ensureObserver();
    setIsReady(check());
    subscribers.add(setIsReady);
    return () => {
      subscribers.delete(setIsReady);
    };
  }, []);

  return isReady;
}

/**
 * Synchronous read for code paths that need to gate an action right now
 * (e.g. a button onClick). Not reactive — use the hook for rendering.
 */
export function isExtensionReady(): boolean {
  return check();
}
