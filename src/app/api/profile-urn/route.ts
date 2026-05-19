import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// Lets the extension bootstrap AppState.myProfileUrn from LinkedIn's
// /voyager/api/me before either sync path runs. Without this, fresh
// installs hit a chicken-and-egg: both sync paths need the URN, but the
// URN is only persisted as a byproduct of a sync.
//
// Body: { myProfileUrn: 'urn:li:fsd_profile:ACoAA...', profileName?: string }
export async function POST(req: NextRequest) {
  let body: { myProfileUrn?: string; profileName?: string } = {};
  try { body = await req.json(); } catch {}
  const urn = (body.myProfileUrn || '').trim();
  if (!/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/.test(urn)) {
    return NextResponse.json(
      { ok: false, reason: 'invalid myProfileUrn shape' },
      { status: 400, headers: CORS },
    );
  }
  const profileName = (body.profileName || '').trim() || undefined;
  await prisma.appState.upsert({
    where: { id: 1 },
    update: { myProfileUrn: urn, ...(profileName ? { profileName } : {}) },
    create: { id: 1, myProfileUrn: urn, profileName },
  });
  return NextResponse.json({ ok: true, myProfileUrn: urn }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
