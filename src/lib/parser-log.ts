// Server-side append to sync-events.log for parser-health telemetry.
// Mirrors the format /api/sync-log uses so the same file holds both
// extension diagnostic events and server-side parser success/failure.
//
// Why a shared file (not a DB table): the existing /api/sync-log already
// writes here, the file is bounded (~500KB), and /api/parser-health just
// needs to scan recent lines. Adding a table felt heavy for telemetry.

import { promises as fs } from 'fs';
import path from 'path';

const LOG_PATH = path.join(process.cwd(), 'sync-events.log');

export type ParserSource = 'sdui-parse' | 'profile-capture-dom' | 'voyager-tap';

export async function logParserResult(source: ParserSource, success: boolean, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      src: source,
      ev: success ? 'parser.success' : 'parser.failure',
      ...detail,
    }) + '\n';
    await fs.appendFile(LOG_PATH, line, 'utf8');
  } catch {
    // Telemetry is best-effort; never throw out of a parser handler.
  }
}
