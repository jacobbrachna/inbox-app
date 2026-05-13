import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET → { companies: [{ name, count }] }
// Aggregates `conversation.enrichment.company` across all non-archived
// conversations. Companies are deduped case-insensitively (e.g. "Stripe" and
// "Stripe Inc" stay separate — we don't try to canonicalize beyond casing).

interface Row { enrichment: string | null; }

function canonicalKey(name: string): string {
  return name.trim().toLowerCase();
}

export async function GET() {
  const rows: Row[] = await prisma.conversation.findMany({
    where: { status: { not: 'archived' }, enrichment: { not: null } },
    select: { enrichment: true },
  });

  // key (lowercased) → { displayName, count }
  const agg = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    if (!r.enrichment) continue;
    let e: { company?: unknown };
    try { e = JSON.parse(r.enrichment); } catch { continue; }
    const company = typeof e.company === 'string' ? e.company.trim() : '';
    if (!company) continue;
    const key = canonicalKey(company);
    const cur = agg.get(key);
    if (cur) cur.count++;
    else agg.set(key, { name: company, count: 1 });
  }

  const companies = Array.from(agg.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return NextResponse.json({ companies, total: companies.length }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
