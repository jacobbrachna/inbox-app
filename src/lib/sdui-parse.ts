// Parser for LinkedIn's SDUI (Server-Driven UI) profile component responses.
// LinkedIn moved profile pages to React Server Components in late 2024;
// the rich data we want lives inside `"children":["..."]` arrays embedded
// in these RSC-flight responses.
//
// Strategy: extract every literal text string from the body, then bucket
// them by content type using header markers ("About", "Experience",
// "Education", "Activity", "Top skills") and pattern matchers.
//
// Component → content map (observed):
//   profileCardsAboveActivity      → About + Top skills + sales insights
//   profileCardsBelowActivityPart1 → Experience + Education + Certifications
//   profileCardsActivity           → Recent posts
//   profileCardsBelowActivityPart5 → Interests (companies/groups followed)

// Match `"children":["<string>"]` where <string> can contain escape
// sequences (\n, \", \\, etc.). The first char must not be "$" so we skip
// component refs like "$Lc". Up to 8000 chars of content.
const TEXT_RE = /"children":\["((?!\$)(?:[^"\\]|\\.){1,8000})"/g;

export interface SduiExtract {
  about?: string;
  skills?: string[];
  prevRoles?: Array<{ role: string | null; company: string | null; from: string | null; to: string | null }>;
  education?: Array<{ school: string | null; degree: string | null; from: string | null; to: string | null }>;
  recentPosts?: Array<{ text: string | null; url: string | null; postedAt: string | null; kind: 'post' | 'reshare' }>;
  jobChangeSignal?: string; // e.g. "Recently hired by Intuitive.ai"
}

// Decode JSON-style escapes in a captured raw string so "\n" → real newline,
// "\"" → ", etc. Defensive: returns raw on parse failure.
function unescape(s: string): string {
  try { return JSON.parse(`"${s}"`); } catch { return s; }
}

function extractTextLines(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  TEXT_RE.lastIndex = 0;
  while ((m = TEXT_RE.exec(body)) !== null) {
    const raw = m[1];
    if (!raw || raw.length < 2) continue;
    const t = unescape(raw);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Lines that look like a date range: "May 2026 - Present · 1 mo", "Apr 2024 - Nov 2025 · 1 yr 8 mos"
const DATE_RANGE_RE = /^([A-Z][a-z]+ \d{4}|\d{4})\s*[-–—]\s*(Present|[A-Z][a-z]+ \d{4}|\d{4})/;

// Detect "Company · Type" line — common in Experience
function splitCompanyType(s: string): { company: string; type: string | null } {
  const parts = s.split(/\s*[·•]\s*/);
  return { company: parts[0].trim(), type: parts[1]?.trim() ?? null };
}

function parseDateLine(s: string): { from: string | null; to: string | null } | null {
  const m = s.match(DATE_RANGE_RE);
  if (!m) return null;
  const to = m[2].toLowerCase() === 'present' ? null : m[2];
  return { from: m[1], to };
}

export function parseSdui(componentId: string, body: string): SduiExtract {
  const lines = extractTextLines(body);
  const shortCid = componentId.split('.').slice(-1)[0];
  const out: SduiExtract = {};

  if (shortCid === 'profileCardsAboveActivity') {
    // About body lives anywhere in the RSC stream (lazy-loaded chunk), not
    // necessarily right after the "About" label. Find the longest prose-like
    // line in the entire component — that's almost always the About text.
    // Filter: must have spaces, can't look like a date or count.
    const candidates = lines
      .filter((l) => l.length >= 60)
      .filter((l) => l.split(' ').length >= 8)
      .filter((l) => !/^\d/.test(l))
      .filter((l) => !/followers?$/i.test(l));
    if (candidates.length > 0) {
      const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
      out.about = longest.slice(0, 4000);
    }
    // "Top skills" then the next line with multiple separators is the skill list
    const skillsIdx = lines.findIndex((l) => l.trim() === 'Top skills');
    if (skillsIdx >= 0) {
      for (let i = skillsIdx + 1; i < Math.min(lines.length, skillsIdx + 5); i++) {
        const candidate = lines[i];
        // "A • B • C" or "A · B · C"
        if (/[•·]/.test(candidate)) {
          out.skills = candidate
            .split(/\s*[•·]\s*/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s.length < 80)
            .slice(0, 10);
          break;
        }
      }
    }
    // Sales Insights → "Key signals" → text after
    const keySigIdx = lines.findIndex((l) => l.trim() === 'Key signals');
    if (keySigIdx >= 0 && lines[keySigIdx + 1]) {
      const sig = lines[keySigIdx + 1].trim();
      if (sig && sig.length < 200) out.jobChangeSignal = sig;
    }
  }

  if (shortCid.startsWith('profileCardsBelowActivityPart')) {
    // LinkedIn dumps Experience + Education + Certifications labels at the
    // top of these components, then streams all content. So we can't split
    // by header position — instead we classify each entry by content:
    //   • Has "Full-time" / "Part-time" / etc. → Experience
    //   • Has university/college/school terms → Education
    //   • "Issued" / "Credential ID" → Certification (skip)
    const entries = collectEntries(lines);
    const jobs: NonNullable<SduiExtract['prevRoles']> = [];
    const schools: NonNullable<SduiExtract['education']> = [];
    for (const e of entries) {
      const merged = `${e.first} ${e.second ?? ''}`.toLowerCase();
      if (/\b(issued|credential id|expires)\b/.test(merged)) continue;
      // Job signal can come from either: the entry text itself mentions
      // full-time/part-time/etc., OR collectEntries saw a dedicated
      // employment-type line during walk-back (set e.isJob).
      const isJob = e.isJob || /\b(full-time|part-time|contract|internship|freelance|self-employed|apprenticeship)\b/.test(merged);
      const isSchool = /\b(university|college|institute|school|bachelor|master|phd|m\.s\.|b\.s\.|b\.tech|m\.tech|mba|degree|graduated)\b/.test(merged);
      if (isJob) {
        jobs.push({
          role: e.first,
          company: e.second ? splitCompanyType(e.second).company : null,
          from: e.dates?.from ?? null,
          to: e.dates?.to ?? null,
        });
      } else if (isSchool) {
        schools.push({
          school: e.first,
          degree: e.second,
          from: e.dates?.from ?? null,
          to: e.dates?.to ?? null,
        });
      }
      // Unclassified entries are skipped — better to have a clean list than
      // to misbucket certifications, awards, etc.
    }
    if (jobs.length > 0) out.prevRoles = jobs.slice(0, 8);
    if (schools.length > 0) out.education = schools.slice(0, 5);
  }

  if (shortCid === 'profileCardsActivity') {
    // Posts list: header is "Activity", then either real posts or
    // "X has no recent posts" placeholder. Real posts have text bodies.
    const noPostsIdx = lines.findIndex((l) => /has no recent posts/i.test(l));
    if (noPostsIdx >= 0) {
      out.recentPosts = [];
    } else {
      // Real posts — pick lines that look like prose (long, contain spaces)
      const posts: Array<{ text: string; url: null; postedAt: null; kind: 'post' }> = [];
      for (const l of lines) {
        if (l.length < 40) continue;
        if (/^\d/.test(l)) continue; // counts like "650 followers"
        if (/followers$/i.test(l)) continue;
        if (/has no recent posts/i.test(l)) continue;
        if (l === 'Activity') continue;
        posts.push({ text: l.slice(0, 600), url: null, postedAt: null, kind: 'post' });
        if (posts.length >= 5) break;
      }
      if (posts.length > 0) out.recentPosts = posts;
    }
  }

  return out;
}

// "Full-time · 1 yr 1 mo" — the employment-type + duration line LinkedIn
// inserts between role title and date range. NOT a role title. We skip it
// during walk-back but record that we saw it, since the marker is also our
// signal that this entry is a job (vs. education/cert).
const EMPLOYMENT_TYPE_LINE = /^(Full-time|Part-time|Contract|Internship|Freelance|Self-employed|Apprenticeship)\b/i;

// Walk a flat list of strings, anchor on date-range lines, and build entries
// by walking backward from each date to find the title + subtitle. Better
// than the forward-scan approach because dates are the most reliable signal
// of "this is an entry boundary."
function collectEntries(lines: string[]): Array<{ first: string; second: string | null; dates: { from: string | null; to: string | null } | null; isJob: boolean }> {
  const out: Array<{ first: string; second: string | null; dates: { from: string | null; to: string | null } | null; isJob: boolean }> = [];
  const SKIP = /^(Show all|Experience|Education|Licenses|Certifications|Skills|Languages|Honors|Volunteer|See more|See less)\b/i;
  // Locations show up between entries: "City, State, Country · On-site" etc.
  // These leak into walk-back if not skipped.
  const LOCATION = /\s·\s(On-site|Remote|Hybrid)$/i;

  // Indices of lines that look like date ranges — these mark entry anchors.
  const dateIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (DATE_RANGE_RE.test(lines[i].trim())) dateIndices.push(i);
  }

  for (const dIdx of dateIndices) {
    const dates = parseDateLine(lines[dIdx].trim());
    if (!dates) continue;
    // Walk backward to find the closest two non-skip lines that aren't dates
    const back: string[] = [];
    let isJob = false; // hint for the classifier — set when we skip an employment-type line
    for (let j = dIdx - 1; j >= 0 && back.length < 2; j--) {
      const l = lines[j].trim();
      if (!l) continue;
      if (SKIP.test(l)) continue;
      if (DATE_RANGE_RE.test(l)) break; // hit another entry
      if (/^Credential ID/i.test(l)) continue;
      if (/^Issued /i.test(l)) continue;
      if (LOCATION.test(l)) continue; // skip prior-entry location
      if (EMPLOYMENT_TYPE_LINE.test(l)) { isJob = true; continue; }
      // Plain location: "City, State, Country" (no · separator)
      if (/^[A-Z][^·]+,[^·]+(,[^·]+)?$/.test(l) && !/(present|inc|llc|ltd|university|college|institute)/i.test(l)) continue;
      back.unshift(l);
    }
    if (back.length === 0) continue;
    out.push({ first: back[0], second: back[1] ?? null, dates, isJob });
  }
  return out;
}
