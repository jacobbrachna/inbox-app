// Helpers shared by route handlers. Kept tiny on purpose — anything that
// touches LinkedIn shape lives in lib/transform.ts.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function safeParseArray<T>(s: string | null | undefined, fallback: T[] = []): T[] {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: CORS });
}
