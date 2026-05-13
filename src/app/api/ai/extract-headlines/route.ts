import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, safeParseArray, optionsResponse } from '@/lib/api-utils';
import { requireAnthropic, MODELS } from '@/lib/ai';
import type { Participant } from '@/types';

// POST { conversationIds?: string[]; force?: boolean }
// Claude extracts { company, role, location } from each contact's LinkedIn
// headline. Batched. Stored on conversation.enrichment (preserves any URL
// already there). Best-effort — many headlines don't have company info.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const explicitIds: string[] | undefined = Array.isArray(body?.conversationIds)
      ? body.conversationIds
      : undefined;
    const force = !!body?.force;

    let rows;
    if (explicitIds && explicitIds.length > 0) {
      rows = await prisma.conversation.findMany({
        where: { id: { in: explicitIds } },
        select: { id: true, participants: true, enrichment: true },
      });
    } else {
      // Default: every non-archived conv we haven't extracted yet
      rows = await prisma.conversation.findMany({
        where: { status: { not: 'archived' } },
        select: { id: true, participants: true, enrichment: true },
      });
    }

    // Filter to those with a headline we could parse, skipping those already
    // enriched unless force=true.
    const candidates: Array<{ id: string; name: string; headline: string; existing: Record<string, unknown> | null }> = [];
    for (const r of rows) {
      const parts = safeParseArray<Participant>(r.participants, []);
      const p = parts[0];
      const headline = p?.headline?.trim();
      if (!headline) continue;
      let existing: Record<string, unknown> | null = null;
      if (r.enrichment) {
        try { existing = JSON.parse(r.enrichment) as Record<string, unknown>; } catch {}
      }
      // Skip if already extracted (has company OR role) unless forcing
      if (!force && existing && (existing.company || existing.role)) continue;
      candidates.push({
        id: r.id,
        name: p?.name ?? 'Unknown',
        headline,
        existing,
      });
    }

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, processed: 0, skipped: rows.length }, { headers: CORS });
    }

    const anthropic = await requireAnthropic();
    const BATCH = 30;
    let processed = 0;
    let totalIn = 0;
    let totalOut = 0;

    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const items = batch.map((c, idx) => `${idx + 1}. ${c.name} — "${c.headline}"`).join('\n');

      const systemPrompt = [
        'You extract structured info from LinkedIn headlines.',
        '',
        'For each headline, return: company (current employer, or null), role (job title, or null), location (city/region only if explicitly in the headline, else null).',
        '',
        'Rules:',
        '• If the headline is just a title (e.g. "Software Engineer"), company is null.',
        '• Strip "ex-", "former", and parenthetical asides ("(ex-Google)" → company is the primary current employer, not "Google").',
        '• Company names should match the canonical brand (e.g. "Stripe", not "Stripe Inc."). Use exactly what the headline says, trimmed.',
        '• role should be the primary title only — no "+ adventurer" or "| AI enthusiast" tails.',
        '• Never invent a company that isn\'t in the headline. If unclear, null.',
      ].join('\n');

      const userPrompt = `${items}\n\nReturn ONLY a JSON array, one object per item in order:
[{"i":1,"company":"Stripe","role":"Engineer","location":null}, ...]
Use null when a field isn't present. No prose.`;

      const response = await anthropic.messages.create({
        model: MODELS.fast,
        max_tokens: 2000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userPrompt }],
      });

      totalIn += response.usage.input_tokens;
      totalOut += response.usage.output_tokens;

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('\n');

      let parsed: Array<{ i: number; company: string | null; role: string | null; location: string | null }> = [];
      try {
        const m = text.match(/\[[\s\S]*\]/);
        if (m) parsed = JSON.parse(m[0]);
      } catch {}

      for (const r of parsed) {
        const target = batch[r.i - 1];
        if (!target) continue;
        const merged: Record<string, unknown> = { ...(target.existing ?? {}) };
        if (r.company) merged.company = r.company;
        if (r.role) merged.role = r.role;
        if (r.location) merged.location = r.location;
        merged.headline = target.headline;
        // Mark as AI-derived so DOM capture can override later
        merged.source = merged.source ?? 'ai-headline';
        if (Object.keys(merged).length === 0) continue;
        await prisma.conversation.update({
          where: { id: target.id },
          data: {
            enrichment: JSON.stringify(merged),
            enrichmentAt: new Date(),
          },
        }).catch(() => {});
        processed++;
      }
      // Be polite — small delay between batches
      if (i + BATCH < candidates.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    return NextResponse.json(
      { ok: true, processed, candidates: candidates.length, usage: { input: totalIn, output: totalOut } },
      { headers: CORS },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    const status = msg.startsWith('NO_API_KEY') ? 401 : 500;
    return NextResponse.json({ error: msg }, { status, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
