// Deterministic ICP-fit scoring. Reads a structured icpDefinition (built by
// /api/icp/build) and scores a contact 0–100 based on title match + seniority
// + keyword hits in headline/about. Designed to run in pure JS over the whole
// conversation table without per-row Claude calls.

export interface IcpDefinition {
  /** Literal target titles, lowercase. Substring matches count. */
  targetTitles?: string[];
  /** Regex strings (case-insensitive) — broader than literal titles.
   *  e.g. "director.*(security|risk)". Each pattern that matches scores. */
  titlePatterns?: string[];
  /** Keywords to search the contact's headline + about for. */
  keywords?: string[];
  /** Weights 0-100 per seniority bucket (case-insensitive match on title). */
  seniorityWeights?: Record<string, number>;
  /** Hard-exclude titles — any match here forces score to 0. */
  excludeTitles?: string[];
  /** Industries / domains the user targets. Lower-weight signal — we only
   *  use these as a soft bonus right now since we rarely have industry data. */
  industries?: string[];
}

interface ContactInfo {
  headline?: string | null;
  role?: string | null;
  about?: string | null;
  company?: string | null;
}

// Order matters — match longest/most-specific bucket first.
const SENIORITY_PATTERNS: Array<[string, RegExp]> = [
  ['C-level', /\b(c[eo]o|cto|cfo|cmo|ciso|cpo|cdo|chief)\b/i],
  ['Founder', /\b(founder|co[- ]?founder|owner|partner)\b/i],
  ['VP', /\b(vp|vice president|svp|evp)\b/i],
  ['Head', /\b(head of)\b/i],
  ['Director', /\b(director|sr\.? director|senior director)\b/i],
  ['Manager', /\b(manager|mgr|lead\b)/i],
  ['Senior IC', /\b(senior|sr\.?|principal|staff|architect)\b/i],
  ['IC', /\b(engineer|analyst|specialist|associate|coordinator|representative)\b/i],
];

function seniorityBucket(title: string): string | null {
  for (const [name, re] of SENIORITY_PATTERNS) {
    if (re.test(title)) return name;
  }
  return null;
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface ScoreBreakdown {
  fit: number;
  excluded: boolean;
  matchedTitles: string[];
  matchedPatterns: string[];
  matchedKeywords: string[];
  seniority: string | null;
}

export function scoreIcp(contact: ContactInfo, def: IcpDefinition): ScoreBreakdown {
  const title = normalize(contact.headline) || normalize(contact.role);
  const about = normalize(contact.about);
  const combined = `${title} ${about}`;

  // Hard exclude — overrides everything else. "Sales Engineer" etc.
  const exclude = (def.excludeTitles ?? []).map(normalize).filter(Boolean);
  for (const ex of exclude) {
    if (title.includes(ex)) {
      return { fit: 0, excluded: true, matchedTitles: [], matchedPatterns: [], matchedKeywords: [], seniority: null };
    }
  }

  // Title literal matches
  const titlesNorm = (def.targetTitles ?? []).map(normalize).filter(Boolean);
  const matchedTitles = titlesNorm.filter((t) => title.includes(t));
  const titleHit = matchedTitles.length > 0;

  // Regex-style patterns (broader)
  const patternHits: string[] = [];
  for (const p of def.titlePatterns ?? []) {
    try {
      const re = new RegExp(p, 'i');
      if (re.test(title)) patternHits.push(p);
    } catch { /* ignore malformed pattern */ }
  }
  const patternHit = patternHits.length > 0;

  // Keyword counts (in headline + about). Each unique keyword counts once.
  const kws = (def.keywords ?? []).map(normalize).filter(Boolean);
  const matchedKeywords = kws.filter((k) => combined.includes(k));

  // Seniority bucket → weight
  const seniority = seniorityBucket(title);
  const seniorityWeight = seniority && def.seniorityWeights
    ? (def.seniorityWeights[seniority] ?? 0)
    : 0;

  // Weighted composite — title match drives most, seniority modulates,
  // keywords are a tiebreaker bonus. Capped at 100.
  // Title score: 100 if literal-match, 80 if regex-only-match, 0 otherwise.
  const titleScore = titleHit ? 100 : (patternHit ? 80 : 0);
  // Keyword score: 0..100 based on how many of the keywords matched.
  const kwScore = kws.length === 0 ? 0 : Math.min(100, (matchedKeywords.length / kws.length) * 100);

  // Weights: title 0.50, seniority 0.35, keywords 0.15.
  const fit = Math.round(
    0.50 * titleScore + 0.35 * seniorityWeight + 0.15 * kwScore,
  );

  return {
    fit: Math.max(0, Math.min(100, fit)),
    excluded: false,
    matchedTitles,
    matchedPatterns: patternHits,
    matchedKeywords,
    seniority,
  };
}

export function parseIcpDefinition(json: string | null | undefined): IcpDefinition | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (v && typeof v === 'object') return v as IcpDefinition;
  } catch {}
  return null;
}
