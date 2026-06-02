import { NextResponse } from 'next/server';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { getConnectionStatus } from '@/lib/zoominfo';

// GET /api/zoominfo/auth/status — Settings UI polls this after the user
// clicks "Connect ZoomInfo" to detect when the OAuth flow completes.
export async function GET() {
  const status = await getConnectionStatus();
  return NextResponse.json(status, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
