import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { invalidateApiKeyCache } from '@/lib/ai';

// GET — return masked indicator (does the key exist?)
export async function GET() {
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  const key = state?.anthropicApiKey ?? '';
  return NextResponse.json(
    {
      hasKey: !!key,
      mask: key ? `…${key.slice(-4)}` : null,
      styleNote: state?.aiStyleNote ?? '',
    },
    { headers: CORS },
  );
}

// PUT — save a new key (and optionally a style note)
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const rawKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : undefined;
    const styleNote = typeof body.styleNote === 'string' ? body.styleNote : undefined;

    // Validate: Anthropic keys start with sk-ant- and are short. Reject
    // obvious paste mistakes (long pastes, error logs, etc).
    if (rawKey !== undefined && rawKey.length > 0) {
      if (!rawKey.startsWith('sk-ant-')) {
        return NextResponse.json(
          { error: `Key must start with "sk-ant-" (got ${JSON.stringify(rawKey.slice(0, 12) + '…')})` },
          { status: 400, headers: CORS },
        );
      }
      if (rawKey.length > 200 || /\s/.test(rawKey)) {
        return NextResponse.json(
          { error: 'Key looks malformed (too long or contains whitespace). Did you paste an error message by mistake?' },
          { status: 400, headers: CORS },
        );
      }
    }

    const data: Record<string, string | null> = {};
    if (rawKey !== undefined) data.anthropicApiKey = rawKey || null;
    if (styleNote !== undefined) data.aiStyleNote = styleNote;

    await prisma.appState.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
      update: data,
    });
    invalidateApiKeyCache();
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500, headers: CORS },
    );
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
