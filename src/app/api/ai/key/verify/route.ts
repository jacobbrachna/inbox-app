import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { MODELS } from '@/lib/ai';

// Probes the configured Anthropic key with a 1-token Haiku call. Used by
// the onboarding wizard to confirm the saved key actually works before
// telling the user they're set.
export async function POST() {
  const state = await prisma.appState.findUnique({ where: { id: 1 } });
  const key = state?.anthropicApiKey;
  if (!key) {
    return NextResponse.json(
      { ok: false, error: 'No key saved' },
      { status: 400, headers: CORS },
    );
  }

  try {
    const client = new Anthropic({ apiKey: key });
    await client.messages.create({
      model: MODELS.fast,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return NextResponse.json({ ok: true }, { headers: CORS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Verification failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400, headers: CORS });
  }
}

export const OPTIONS = optionsResponse;
