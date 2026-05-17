import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CORS, optionsResponse } from '@/lib/api-utils';

// GET /api/tasks/job-changes — contacts whose most recent ContactSnapshot
// differs from their second-most-recent snapshot on company or role. Sorted
// newest change first.
//
// We use SQL window functions to grab the latest two snapshots per contact.
// That keeps it efficient even at scale.

export interface JobChange {
  contactId: string;
  name: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  changedAt: string;
  // What changed
  previousCompany: string | null;
  newCompany: string | null;
  previousRole: string | null;
  newRole: string | null;
  changeKind: 'company' | 'role' | 'both';
}

export async function GET() {
  // Fetch the latest two snapshots per contact via raw SQL window function.
  type Row = {
    contactId: string;
    name: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    capturedAt: string;
    company: string | null;
    role: string | null;
    rn: number;
  };
  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT
      s.contactId  AS contactId,
      c.name       AS name,
      c.avatarUrl  AS avatarUrl,
      c.profileUrl AS profileUrl,
      s.capturedAt AS capturedAt,
      s.company    AS company,
      s.role       AS role,
      ROW_NUMBER() OVER (PARTITION BY s.contactId ORDER BY s.capturedAt DESC) AS rn
    FROM ContactSnapshot s
    JOIN Contact c ON c.id = s.contactId
    ORDER BY s.contactId, s.capturedAt DESC
  `);

  // Walk grouped by contactId — we only need rn=1 and rn=2.
  const grouped = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.rn > 2) continue;
    if (!grouped.has(r.contactId)) grouped.set(r.contactId, []);
    grouped.get(r.contactId)!.push(r);
  }

  const changes: JobChange[] = [];
  for (const [, pair] of grouped) {
    if (pair.length < 2) continue;
    const [latest, prior] = pair;
    const companyChanged = (latest.company ?? '') !== (prior.company ?? '');
    const roleChanged = (latest.role ?? '') !== (prior.role ?? '');
    if (!companyChanged && !roleChanged) continue;
    const kind: JobChange['changeKind'] =
      companyChanged && roleChanged ? 'both' : companyChanged ? 'company' : 'role';
    changes.push({
      contactId: latest.contactId,
      name: latest.name,
      avatarUrl: latest.avatarUrl,
      profileUrl: latest.profileUrl,
      changedAt: latest.capturedAt,
      previousCompany: prior.company,
      newCompany: latest.company,
      previousRole: prior.role,
      newRole: latest.role,
      changeKind: kind,
    });
  }

  changes.sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime());

  return NextResponse.json({ changes, count: changes.length }, { headers: CORS });
}

export async function OPTIONS() {
  return optionsResponse();
}
