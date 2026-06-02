// ZoomInfo OAuth + REST API client. Auth lives on AppState (per-user
// access + refresh tokens). Client credentials come from .env, shipped
// inside the .app bundle.
//
// Endpoints are resolved from env so we can adjust if ZoomInfo's portal
// gives us non-default URLs. Defaults match ZI's standard Okta-fronted
// OAuth + their public REST base.

import { prisma } from '@/lib/db';

const CLIENT_ID = process.env.ZOOMINFO_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.ZOOMINFO_CLIENT_SECRET ?? '';

// Auth host. ZI's docs reference both api.zoominfo.com and login.zoominfo.com
// across versions. Override via env if needed.
const AUTH_BASE = process.env.ZOOMINFO_AUTH_BASE ?? 'https://api.zoominfo.com';
const AUTHORIZE_URL = `${AUTH_BASE}/authorize`;
const TOKEN_URL = `${AUTH_BASE}/token`;

// REST API base for enrichment + search calls.
const API_BASE = process.env.ZOOMINFO_API_BASE ?? 'https://api.zoominfo.com';

// Redirect URI must match the one registered in the ZI dev portal.
export const REDIRECT_URI = 'http://localhost:54321/callback';

// Scopes the user grants Relay during OAuth. Read-only, matching the
// boxes ticked in the dev portal.
export const SCOPES = [
  'data:company:read',
  'data:contact:read',
  'data:scoops:read',
  'data:news:read',
  'data:intent:read',
  'context:gtm:read',
  'entitlements:read',
];

export function hasCredentials(): boolean {
  return !!CLIENT_ID && !!CLIENT_SECRET;
}

/** Build the ZoomInfo /authorize URL the user opens in their browser. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  token_type: string;
}

/** Exchange the OAuth `code` for tokens. Called from /api/zoominfo/auth/callback. */
export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  // Client credentials go in the Basic auth header per OAuth 2.0 spec.
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token exchange failed (${r.status}): ${text.slice(0, 400)}`);
  }
  return (await r.json()) as TokenResponse;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token refresh failed (${r.status}): ${text.slice(0, 400)}`);
  }
  return (await r.json()) as TokenResponse;
}

/** Persist a fresh token set on AppState. */
export async function saveTokens(tokens: TokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
  await prisma.appState.update({
    where: { id: 1 },
    data: {
      zoominfoAccessToken: tokens.access_token,
      // ZI doesn't always issue a new refresh token on refresh — keep the
      // existing one if it doesn't come back.
      ...(tokens.refresh_token ? { zoominfoRefreshToken: tokens.refresh_token } : {}),
      zoominfoTokenExpiresAt: expiresAt,
      zoominfoConnectedAt: new Date(),
    },
  });
}

export async function clearTokens(): Promise<void> {
  await prisma.appState.update({
    where: { id: 1 },
    data: {
      zoominfoAccessToken: null,
      zoominfoRefreshToken: null,
      zoominfoTokenExpiresAt: null,
      zoominfoConnectedAt: null,
    },
  });
}

/** Returns a valid access token, refreshing if expired. Throws if not connected. */
async function getValidAccessToken(): Promise<string> {
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  if (!state?.zoominfoRefreshToken) throw new Error('Not connected to ZoomInfo');
  const now = Date.now();
  const expiresAt = state.zoominfoTokenExpiresAt?.getTime() ?? 0;
  if (state.zoominfoAccessToken && expiresAt > now + 30_000) {
    return state.zoominfoAccessToken;
  }
  const fresh = await refreshTokens(state.zoominfoRefreshToken);
  await saveTokens(fresh);
  return fresh.access_token;
}

/** Generic POST helper for ZI REST endpoints. */
async function ziPost<T>(pathname: string, body: unknown): Promise<T> {
  const token = await getValidAccessToken();
  const r = await fetch(`${API_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`ZoomInfo ${pathname} ${r.status}: ${text.slice(0, 400)}`);
  }
  return (await r.json()) as T;
}

// ── Public API ─────────────────────────────────────────────────────────

export interface EnrichedCompany {
  zoominfoCompanyId?: string;
  name?: string;
  website?: string;
  domain?: string;
  description?: string;
  industries?: string[];
  employeeCount?: number;
  employeeRange?: string;
  revenue?: number;
  revenueRange?: string;
  recentFundingAmount?: number;
  recentFundingDate?: string;
  totalFundingAmount?: number;
  foundedYear?: number;
  ticker?: string;
  metroArea?: string;
}

export interface ScoopItem {
  scoopId: string;
  scoopType: string;
  description: string;
  originalPublishedDate?: string;
  link?: string;
  department?: string;
}

export interface NewsItem {
  title?: string;
  description?: string;
  publishingDate?: string;
  url?: string;
  category?: string;
}

/** Single-company enrichment by domain (or company name as a fallback). */
export async function enrichCompany(opts: {
  domain?: string;
  companyName?: string;
}): Promise<EnrichedCompany | null> {
  const payload = {
    matchCompanyInput: [{
      ...(opts.domain ? { companyWebsite: opts.domain } : {}),
      ...(opts.companyName ? { companyName: opts.companyName } : {}),
    }],
    outputFields: [
      'name', 'website', 'domain', 'description', 'industries',
      'employeeCount', 'employeeRange', 'revenue', 'revenueRange',
      'recentFundingAmount', 'recentFundingDate', 'totalFundingAmount',
      'foundedYear', 'ticker', 'metroArea',
    ],
  };
  const resp = await ziPost<{ data?: { result?: Array<{ data?: EnrichedCompany & { id?: string } }> } }>(
    '/enrich/company',
    payload,
  );
  const first = resp?.data?.result?.[0]?.data;
  if (!first) return null;
  return { ...first, zoominfoCompanyId: first.id ?? undefined };
}

/** Recent scoops (signals) for a company — funding, hiring, exec moves, etc. */
export async function enrichScoops(opts: {
  zoominfoCompanyIds?: string[];
  companyWebsites?: string[];
  publishedStartDate?: string;
  pageSize?: number;
}): Promise<ScoopItem[]> {
  // Default to last 90 days if not specified.
  const startDate = opts.publishedStartDate ??
    new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const payload: Record<string, unknown> = {
    publishedStartDate: startDate,
    sort: '-originalPublishedDate',
    pageSize: opts.pageSize ?? 25,
  };
  if (opts.zoominfoCompanyIds?.length) payload.zoominfoCompanyIds = opts.zoominfoCompanyIds;
  if (opts.companyWebsites?.length) payload.companyWebsites = opts.companyWebsites;
  const resp = await ziPost<{ data?: ScoopItem[] }>('/enrich/scoops', payload);
  return resp?.data ?? [];
}

/** Recent news articles for a company. */
export async function enrichNews(opts: {
  zoominfoCompanyId: number | string;
  publishingDateStart?: string;
  categories?: string[];
}): Promise<NewsItem[]> {
  const start = opts.publishingDateStart ??
    new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const payload = {
    zoominfoCompanyId: typeof opts.zoominfoCompanyId === 'string'
      ? parseInt(opts.zoominfoCompanyId, 10)
      : opts.zoominfoCompanyId,
    publishingDateStart: start,
    ...(opts.categories?.length ? { categories: opts.categories } : {}),
  };
  const resp = await ziPost<{ data?: NewsItem[] }>('/enrich/news', payload);
  return resp?.data ?? [];
}

/** Connection status for the Settings UI. */
export async function getConnectionStatus() {
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  return {
    connected: !!state?.zoominfoAccessToken,
    connectedAt: state?.zoominfoConnectedAt?.toISOString() ?? null,
    expiresAt: state?.zoominfoTokenExpiresAt?.toISOString() ?? null,
    hasCredentials: hasCredentials(),
  };
}
