import { NextResponse } from 'next/server';
import { CORS, optionsResponse } from '@/lib/api-utils';
import {
  buildAuthorizeUrl, exchangeCodeForTokens, saveTokens, hasCredentials,
} from '@/lib/zoominfo';
import crypto from 'crypto';

// POST /api/zoominfo/auth/start
//
// Initiates the OAuth flow:
//   1. Generates a random `state` for CSRF protection
//   2. Asks the main process to spin up the :54321 callback listener
//   3. Returns the ZoomInfo /authorize URL + an awaitable Promise for the code
//
// The renderer is responsible for opening the URL in the system browser
// (via shell.openExternal — exposed through window.open + setWindowOpenHandler).
// When ZI redirects to /callback, the main-process listener resolves a
// Promise we await here, then we swap the code for tokens.
export async function POST() {
  if (!hasCredentials()) {
    return NextResponse.json(
      { error: 'ZoomInfo credentials not configured in .env' },
      { status: 500, headers: CORS },
    );
  }
  const oauthBridge = (globalThis as { __relayOAuth?: { start: () => Promise<{ code: string; state: string }> } }).__relayOAuth;
  if (!oauthBridge) {
    return NextResponse.json(
      { error: 'OAuth listener not available (not running inside Electron?)' },
      { status: 500, headers: CORS },
    );
  }

  const state = crypto.randomBytes(16).toString('hex');
  // Start listening BEFORE returning the authorize URL so we can't miss
  // a fast redirect. Resolve asynchronously when the callback fires.
  const codePromise = oauthBridge.start();
  const url = buildAuthorizeUrl(state);

  // Fire-and-forget: when the redirect comes in, swap for tokens.
  codePromise
    .then(async ({ code, state: returnedState }) => {
      if (returnedState !== state) {
        console.error('[zoominfo] state mismatch — possible CSRF, ignoring callback');
        return;
      }
      try {
        const tokens = await exchangeCodeForTokens(code);
        await saveTokens(tokens);
      } catch (e) {
        console.error('[zoominfo] token exchange failed:', e);
      }
    })
    .catch((e) => console.error('[zoominfo] OAuth flow failed:', e));

  return NextResponse.json({ authorizeUrl: url }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
