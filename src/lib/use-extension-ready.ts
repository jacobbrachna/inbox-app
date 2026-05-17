'use client';
import { useEffect, useState } from 'react';

const MARKER_ID = 'inboxpro-bridge-marker';

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
  observer = new MutationObserver(() => notify(check()));
  observer.observe(document.body, { childList: true, subtree: false });
}

/**
 * Returns true once the InboxPro Chrome extension has injected its bridge
 * marker into the page. A single MutationObserver watches document.body —
 * every call site subscribes to the same source instead of polling.
 */
export function useExtensionReady(): boolean {
  const [isReady, setIsReady] = useState<boolean>(() => check());

  useEffect(() => {
    ensureObserver();
    // Sync with the shared source on mount in case it already flipped.
    setIsReady(ready);
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
