// Prompt context builders for AI endpoints (draft-reply, improve-draft,
// future coach). Three distinct blocks:
//
//   buildContactContextBlock — "who you're writing TO" (recipient)
//   buildSenderContextBlock  — "who you are + what you sell" (from AppState)
//   buildDocsContextBlock    — uploaded reference docs (Documents.summary)
//
// All JSON columns are parsed defensively — bad payloads are skipped, not
// thrown. postedAt is similarly guarded; legacy rows may have unparseable
// strings like "1w •" from before markerToISO() landed.
//
// Callers should compose these three (sender + docs + contact) in that
// order so Claude reads "here's me" → "my reference material" → "here's
// them" before the transcript.

export const CONTACT_CONTEXT_SELECT = {
  name: true,
  headline: true,
  company: true,
  role: true,
  about: true,
  prevRoles: true,
  education: true,
  skills: true,
  recentPosts: true,
} as const;

export type ContactContextInput = {
  name?: string | null;
  headline?: string | null;
  company?: string | null;
  role?: string | null;
  about?: string | null;
  prevRoles?: string | null;
  education?: string | null;
  skills?: string | null;
  recentPosts?: string | null;
} | null | undefined;

function safeParse<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function fmtDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function buildContactContextBlock(
  contact: ContactContextInput,
  otherPersonName: string,
): string {
  if (!contact) return '';
  const lines: string[] = [];

  if (contact.about) {
    lines.push(`About (their own words):\n${contact.about.slice(0, 600)}`);
  }
  if (contact.role && contact.company) {
    lines.push(`Current role: ${contact.role} @ ${contact.company}`);
  }

  const prev = safeParse<Array<{ role?: string; company?: string; from?: string; to?: string }>>(contact.prevRoles);
  if (Array.isArray(prev) && prev.length > 0) {
    const fmt = prev.slice(0, 3)
      .map((p) => `${p.role || '?'} @ ${p.company || '?'}`)
      .join(', ');
    lines.push(`Prior roles: ${fmt}`);
  }

  const edu = safeParse<Array<{ school?: string; degree?: string }>>(contact.education);
  if (Array.isArray(edu) && edu.length > 0) {
    const fmt = edu.slice(0, 2)
      .map((e) => e.degree ? `${e.degree} — ${e.school || '?'}` : (e.school || '?'))
      .join('; ');
    lines.push(`Education: ${fmt}`);
  }

  const skills = safeParse<string[]>(contact.skills);
  if (Array.isArray(skills) && skills.length > 0) {
    lines.push(`Top skills: ${skills.slice(0, 8).join(', ')}`);
  }

  const posts = safeParse<Array<{ text?: string; postedAt?: string }>>(contact.recentPosts);
  if (Array.isArray(posts) && posts.length > 0) {
    const fmt = posts.slice(0, 3)
      .map((p) => {
        const when = fmtDate(p.postedAt) ?? '?';
        return `[${when}] ${(p.text || '').slice(0, 180)}`;
      })
      .filter((s) => s.length > 5)
      .join('\n');
    if (fmt) {
      lines.push(`Recent posts (use these for relevant hooks, never paraphrase or quote directly):\n${fmt}`);
    }
  }

  if (lines.length === 0) return '';
  return `\nContext about ${otherPersonName}:\n${lines.join('\n\n')}\n\nUse this context naturally where it adds value — referencing a specific point from their About or a recent post often outperforms generic openers. Don't force it. If nothing fits, skip it.`;
}

export type SenderContextInput = {
  myCompany?: string | null;
  myRole?: string | null;
  companyOneLiner?: string | null;
  outreachGoal?: string | null;
  idealCustomerProfile?: string | null;
  keyValueProps?: string | null;
} | null | undefined;

export function buildSenderContextBlock(state: SenderContextInput): string {
  if (!state) return '';
  const lines: string[] = [];
  if (state.myRole && state.myCompany) {
    lines.push(`Sender role: ${state.myRole} at ${state.myCompany}`);
  } else if (state.myCompany) {
    lines.push(`Sender company: ${state.myCompany}`);
  } else if (state.myRole) {
    lines.push(`Sender role: ${state.myRole}`);
  }
  if (state.companyOneLiner) lines.push(`What ${state.myCompany || 'we'} does: ${state.companyOneLiner}`);
  if (state.outreachGoal) lines.push(`Outreach goal: ${state.outreachGoal}`);
  if (state.idealCustomerProfile) lines.push(`Ideal customer:\n${state.idealCustomerProfile}`);
  if (state.keyValueProps) lines.push(`Key value props:\n${state.keyValueProps}`);
  if (lines.length === 0) return '';
  return `\nAbout the sender (write FROM this perspective):\n${lines.join('\n\n')}`;
}

// A doc's summary as it appears in prompts. List is built from the
// Document table filtered to includeByDefault = true.
export type DocBrief = { title: string; kind?: string | null; summary?: string | null };

export function buildDocsContextBlock(docs: DocBrief[] | null | undefined): string {
  if (!Array.isArray(docs) || docs.length === 0) return '';
  const blocks = docs
    .filter((d) => d.summary && d.summary.trim().length > 0)
    .map((d) => {
      const header = d.kind && d.kind !== 'other' ? `[${d.kind}] ${d.title}` : d.title;
      return `### ${header}\n${(d.summary || '').trim()}`;
    });
  if (blocks.length === 0) return '';
  return `\nReference material (cite specifics from these when they fit the conversation — never fabricate stats or claims not present here):\n\n${blocks.join('\n\n')}`;
}

