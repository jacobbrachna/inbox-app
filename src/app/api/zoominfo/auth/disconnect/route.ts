import { NextResponse } from 'next/server';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { clearTokens } from '@/lib/zoominfo';

// POST /api/zoominfo/auth/disconnect — wipes the stored ZI tokens.
// Doesn't revoke the grant on ZI's side (user can do that from their
// ZoomInfo account settings if they want). Cached enrichment on
// Conversations is preserved — disconnect is just for re-authing.
export async function POST() {
  await clearTokens();
  return NextResponse.json({ ok: true }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
