// Server-only helper for talking to the Claude API.
// The key is read from AppState (server-side) on every call — never sent to
// the client. All /api/ai/* routes funnel through this.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';

let cachedKey: string | null = null;

async function getApiKey(): Promise<string | null> {
  if (cachedKey) return cachedKey;
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  cachedKey = state?.anthropicApiKey ?? null;
  return cachedKey;
}

// Call after the user updates the key in Settings so the next request picks
// up the new value without restarting the server.
export function invalidateApiKeyCache() {
  cachedKey = null;
}

export async function getAnthropic(): Promise<Anthropic | null> {
  const key = await getApiKey();
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

// Default models. Sonnet for drafts (writes well), Haiku for cheap tasks.
export const MODELS = {
  draft: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5-20251001',
} as const;

// Convenience: assert key exists, throw if not.
export async function requireAnthropic(): Promise<Anthropic> {
  const c = await getAnthropic();
  if (!c) {
    throw new Error('NO_API_KEY: set your Anthropic API key in Settings');
  }
  return c;
}

// Returns true if an API key is configured. Lightweight check for gating
// features (e.g., skip regex auto-labels when AI labeling is available).
export async function hasApiKey(): Promise<boolean> {
  const key = await getApiKey();
  return !!key;
}
