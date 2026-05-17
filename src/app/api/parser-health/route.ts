import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/parser-health?windowHours=168 → per-source success stats.
//
// Reads sync-events.log (where logParserResult appends parser.success /
// parser.failure events) and aggregates by src for the requested window.
// Default window is 7 days. Used by:
//   • Diagnostics panel "Parser health" widget
//   • background.js daily anomaly alarm
//
// Output shape:
//   {
//     windowHours: 168,
//     generatedAt: ISO,
//     sources: [
//       { source, total, success, failure, rate, lastSampleAt, samples24h }
//     ]
//   }
// rate is 0..1; lastSampleAt is ISO or null if no samples.

const LOG_PATH = path.join(process.cwd(), 'sync-events.log');
const KNOWN_SOURCES = ['sdui-parse', 'profile-capture-dom', 'voyager-tap'] as const;

type Entry = { t?: string; src?: string; ev?: string };

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const windowHours = Math.max(1, Math.min(720, parseInt(searchParams.get('windowHours') ?? '168', 10)));
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const cutoff24h = Date.now() - 24 * 3600 * 1000;

  let lines: string[] = [];
  try {
    const txt = await fs.readFile(LOG_PATH, 'utf8');
    lines = txt.trim().split('\n');
  } catch {
    // log file may not exist yet
  }

  type Bucket = { total: number; success: number; failure: number; lastSampleAt: string | null; samples24h: number };
  const empty = (): Bucket => ({ total: 0, success: 0, failure: 0, lastSampleAt: null, samples24h: 0 });
  const buckets = new Map<string, Bucket>();
  for (const s of KNOWN_SOURCES) buckets.set(s, empty());

  for (const line of lines) {
    let j: Entry;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.ev !== 'parser.success' && j.ev !== 'parser.failure') continue;
    const src = j.src ?? '';
    if (!KNOWN_SOURCES.includes(src as typeof KNOWN_SOURCES[number])) continue;
    const ts = j.t ? Date.parse(j.t) : NaN;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const b = buckets.get(src)!;
    b.total++;
    if (j.ev === 'parser.success') b.success++;
    else b.failure++;
    if (ts >= cutoff24h) b.samples24h++;
    if (!b.lastSampleAt || ts > Date.parse(b.lastSampleAt)) b.lastSampleAt = new Date(ts).toISOString();
  }

  const sources = [...buckets.entries()].map(([source, b]) => ({
    source,
    total: b.total,
    success: b.success,
    failure: b.failure,
    rate: b.total > 0 ? b.success / b.total : null,
    lastSampleAt: b.lastSampleAt,
    samples24h: b.samples24h,
  }));

  return NextResponse.json({
    windowHours,
    generatedAt: new Date().toISOString(),
    sources,
  }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
