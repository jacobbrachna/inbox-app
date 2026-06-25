import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { CORS, optionsResponse } from '@/lib/api-utils';
import { upsertContact } from '@/lib/contact-upsert';

// POST /api/import/connections
// Accepts EITHER the raw LinkedIn connections API payload ({ raw }) — which we
// parse defensively here — OR pre-parsed records ({ connections: [...] }).
//
// The extension forwards the raw connections-page API response (the page makes
// the call; we read what's already fetched). Because LinkedIn's exact shape
// varies, we (1) persist the most recent raw payload next to the DB for
// debugging/tuning, and (2) parse with a recursive walk that joins member
// profiles to their connection timestamps. connectedOn is the win here — it's
// what the New Connections list needs to tell new from old.

interface ConnRecord {
  slug?: string | null;
  urn?: string | null;
  name: string;
  headline?: string | null;
  company?: string | null;
  role?: string | null;
  avatarUrl?: string | null;
  connectedAtMs?: number | null;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Build an avatar URL from a LinkedIn profilePicture/vectorImage structure.
function avatarFrom(member: Record<string, unknown>): string | undefined {
  // profilePicture.displayImageReference.vectorImage { rootUrl, artifacts }
  const pp = asObj(member.profilePicture) ?? asObj(member.picture);
  const ref = asObj(pp?.displayImageReference) ?? pp;
  const vi = asObj(ref?.vectorImage) ?? asObj(ref);
  const root = asStr(vi?.rootUrl);
  if (!root) return undefined;
  const arts = Array.isArray(vi?.artifacts) ? (vi!.artifacts as unknown[]) : [];
  const last = asObj(arts[arts.length - 1]);
  const seg = asStr(last?.fileIdentifyingUrlPathSegment);
  return seg ? root + seg : root;
}

function recordFromMember(member: Record<string, unknown>, connectedAtMs?: number): ConnRecord | null {
  const first = asStr(member.firstName) ?? '';
  const last = asStr(member.lastName) ?? '';
  const slug = asStr(member.publicIdentifier);
  const name = `${first} ${last}`.trim() || asStr(member.name) || '';
  if (!name && !slug) return null;
  const urn = asStr(member.entityUrn) ?? asStr(member.objectUrn);
  // occupation/headline often "Title at Company" — derive a company guess.
  const headline = asStr(member.headline) ?? asStr(member.occupation);
  let company: string | undefined;
  let role: string | undefined;
  if (headline) {
    const m = headline.split(/\s+(?:at|@|\||·)\s+/);
    if (m.length >= 2) { role = m[0].trim(); company = m[m.length - 1].trim(); }
  }
  return {
    slug: slug ?? null,
    urn: urn ?? null,
    name,
    headline: headline ?? null,
    company: company ?? null,
    role: role ?? null,
    avatarUrl: avatarFrom(member) ?? null,
    connectedAtMs: connectedAtMs ?? null,
  };
}

// Recursively find connection entries. Handles the common REST shape
// (elements[] with connectedMemberResolutionResult + createdAt) and falls back
// to any object carrying a member-like profile, joining a sibling timestamp.
function parseConnections(raw: unknown): ConnRecord[] {
  const out: ConnRecord[] = [];
  const seen = new Set<string>();
  const push = (rec: ConnRecord | null) => {
    if (!rec) return;
    const key = rec.urn || rec.slug || rec.name;
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(rec);
  };
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const o = asObj(node);
    if (!o) return;
    const member =
      asObj(o.connectedMemberResolutionResult) ??
      asObj(o.connectedMember) ??
      asObj(o.miniProfile);
    const createdAt = asNum(o.createdAt) ?? asNum(o.connectedAt);
    if (member && (member.firstName || member.lastName || member.publicIdentifier)) {
      push(recordFromMember(member, createdAt));
    } else if ((o.firstName || o.lastName) && o.publicIdentifier) {
      // A bare profile entity (GraphQL `included`) — no timestamp on this node.
      push(recordFromMember(o, createdAt));
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(raw);
  return out;
}

function debugDir(): string {
  const dbUrl = process.env.DATABASE_URL ?? 'file:./dev.db';
  return path.dirname(path.resolve(dbUrl.replace(/^file:/, '')));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let records: ConnRecord[] = [];

    if (Array.isArray(body?.connections)) {
      records = body.connections as ConnRecord[];
    } else if (body?.raw !== undefined) {
      // Persist the most recent raw payload for parser tuning.
      try {
        fs.writeFileSync(path.join(debugDir(), 'connections-raw-last.json'), JSON.stringify(body.raw).slice(0, 2_000_000));
      } catch { /* best effort */ }
      records = parseConnections(body.raw);
    } else {
      return NextResponse.json({ error: 'connections[] or raw required' }, { status: 400, headers: CORS });
    }

    let upserted = 0, withDate = 0;
    for (const r of records) {
      if (!r || !r.name) continue;
      const connectedOn = r.connectedAtMs ? new Date(r.connectedAtMs) : null;
      if (connectedOn) withDate++;
      const id = await upsertContact({
        linkedinUrn: r.urn ?? null,
        profileSlug: r.slug ?? null,
        profileUrl: r.slug ? `https://www.linkedin.com/in/${r.slug}/` : null,
        name: r.name,
        headline: r.headline ?? null,
        avatarUrl: r.avatarUrl ?? null,
        company: r.company ?? null,
        role: r.role ?? null,
        connectedOn,
        source: 'dom-capture',
      });
      if (id) upserted++;
    }

    return NextResponse.json(
      { ok: true, parsed: records.length, upserted, withDate },
      { headers: CORS },
    );
  } catch (e) {
    const m = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: m }, { status: 500, headers: CORS });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
