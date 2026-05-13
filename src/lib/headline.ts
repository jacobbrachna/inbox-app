// Extract the company name from a LinkedIn-style headline.
//
// Headlines are messy: "Director of Engineering at Acme", "VP @ Stripe",
// "Founder · Box Inc", "Engineer | Stripe (ex-Google)", "Stripe — Engineer".
// We try common separators in order and pick what looks most like a company.

const TRAILING_NOISE = /\s*[\(\[].*$/; // " (ex-Google)" tail
const COMPANY_NOISE = /^(ex-|former |formerly )/i;
const SEPARATOR_PATTERNS: Array<{ regex: RegExp; companyOnRight: boolean }> = [
  { regex: /\s+at\s+/i,        companyOnRight: true  },
  { regex: /\s*@\s+/,           companyOnRight: true  },
  { regex: /\s+with\s+/i,      companyOnRight: true  },
  { regex: /\s*[·•]\s*/,        companyOnRight: true  },
  { regex: /\s+—\s+/,           companyOnRight: false }, // "Stripe — Engineer"
  { regex: /\s+-\s+/,           companyOnRight: false },
  { regex: /\s*\|\s*/,          companyOnRight: false },
];

// Anything obviously NOT a company on its own (single common-noun job titles)
const NOT_A_COMPANY = new Set([
  'engineer', 'engineering', 'founder', 'designer', 'developer', 'manager',
  'director', 'consultant', 'student', 'graduate', 'professional', 'specialist',
  'analyst', 'recruiter', 'sales', 'marketing', 'product', 'operations',
  'finance', 'people', 'hr', 'cofounder', 'co-founder', 'ceo', 'cto', 'cfo',
  'coo', 'vp', 'svp', 'evp', 'lead', 'principal', 'senior', 'junior',
]);

function clean(s: string): string {
  return s
    .replace(TRAILING_NOISE, '')
    .replace(COMPANY_NOISE, '')
    .replace(/\.+$/, '')
    .replace(/^the\s+/i, '')
    .trim();
}

function looksLikeCompany(s: string): boolean {
  if (!s || s.length < 2 || s.length > 60) return false;
  if (NOT_A_COMPANY.has(s.toLowerCase())) return false;
  // Reject if it's mostly a verb-y phrase (3+ words, none capitalized)
  const words = s.split(/\s+/);
  if (words.length > 5) return false;
  const hasCapital = /[A-Z]/.test(s);
  if (words.length >= 2 && !hasCapital) return false;
  return true;
}

export function extractCompany(headline: string | undefined | null): string | null {
  if (!headline) return null;
  const h = headline.trim();
  if (!h) return null;

  for (const { regex, companyOnRight } of SEPARATOR_PATTERNS) {
    const m = h.split(regex);
    if (m.length < 2) continue;
    const candidate = clean(companyOnRight ? m.slice(1).join(' ').split(/\s*[•·,]\s*/)[0] : m[0]);
    if (looksLikeCompany(candidate)) return candidate;
  }

  // Fallback: if the headline is a short, capitalized-looking single phrase,
  // it might be the company itself ("Stripe", "OpenAI").
  if (h.length < 30 && /^[A-Z]/.test(h) && !h.includes(' at ') && h.split(' ').length <= 3) {
    if (looksLikeCompany(h)) return h;
  }

  return null;
}

// Canonical key for grouping ("Stripe Inc." and "Stripe" should bucket together).
export function companyKey(company: string): string {
  return company
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+(inc|llc|ltd|gmbh|corp|corporation|company|co)\b\.?/gi, '')
    .trim();
}
