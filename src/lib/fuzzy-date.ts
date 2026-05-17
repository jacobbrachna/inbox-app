// Resolve fuzzy follow-up timing language to a concrete future Date.
// Primary use: sanity-checking dates the AI returns from message classification,
// and supporting keyword-only auto-detection that doesn't burn a Claude call.
//
// Always returns a future date (or null if the phrase can't be parsed).
// Always snaps to a weekday — follow-ups land Mon-Fri.
//
// Confidence is 'high' for explicit/quantified phrases ("3 weeks", "September")
// and 'low' for vague language ("soon", "down the line").

export type Confidence = 'high' | 'low';

export interface DateResolution {
  date: Date;
  confidence: Confidence;
  basis: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function snapToWeekday(d: Date): Date {
  const day = d.getDay();
  if (day === 0) return new Date(d.getTime() + DAY_MS);     // Sun → Mon
  if (day === 6) return new Date(d.getTime() + 2 * DAY_MS); // Sat → Mon
  return d;
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

// Quarter start dates (Q1 Jan, Q2 Apr, Q3 Jul, Q4 Oct).
function nextQuarterStart(now: Date): Date {
  const m = now.getMonth();
  const y = now.getFullYear();
  const nextQ = m < 3 ? 3 : m < 6 ? 6 : m < 9 ? 9 : 12;
  return nextQ === 12
    ? new Date(Date.UTC(y + 1, 0, 1))
    : new Date(Date.UTC(y, nextQ, 1));
}

// Returns the next upcoming occurrence of a given month (1st of that month).
function nextMonth(monthIdx: number, now: Date): Date {
  const y = now.getFullYear();
  const candidate = new Date(Date.UTC(y, monthIdx, 1));
  if (candidate.getTime() <= now.getTime()) {
    return new Date(Date.UTC(y + 1, monthIdx, 1));
  }
  return candidate;
}

export function resolveFuzzyDate(phrase: string, now: Date = new Date()): DateResolution | null {
  if (!phrase) return null;
  const p = phrase.toLowerCase().trim();

  // 1. Explicit days/weeks/months ahead
  const dayMatch = p.match(/(\d+)\s*(day|week|month)s?/);
  if (dayMatch) {
    const n = parseInt(dayMatch[1], 10);
    const unit = dayMatch[2];
    const days = unit === 'day' ? n : unit === 'week' ? n * 7 : n * 30;
    return { date: snapToWeekday(addDays(now, days)), confidence: 'high', basis: `${n} ${unit}${n === 1 ? '' : 's'} from now` };
  }

  // 2. Fuzzy multipliers
  if (/\ba few days?\b/.test(p) || /\bin a few days?\b/.test(p)) {
    return { date: snapToWeekday(addDays(now, 4)), confidence: 'high', basis: '~4 days' };
  }
  if (/\ba couple weeks?\b/.test(p)) {
    return { date: snapToWeekday(addDays(now, 14)), confidence: 'high', basis: '~2 weeks' };
  }
  if (/\ba few weeks?\b/.test(p)) {
    return { date: snapToWeekday(addDays(now, 21)), confidence: 'high', basis: '~3 weeks' };
  }
  if (/\ba couple months?\b/.test(p)) {
    return { date: snapToWeekday(addDays(now, 60)), confidence: 'high', basis: '~2 months' };
  }
  if (/\ba few months?\b/.test(p)) {
    return { date: snapToWeekday(addDays(now, 90)), confidence: 'low', basis: '~3 months' };
  }

  // 3. Named timeframes
  if (/\bnext month\b/.test(p)) {
    return { date: snapToWeekday(addDays(now, 30)), confidence: 'high', basis: 'next month (~30 days)' };
  }
  if (/\bnext week\b/.test(p)) {
    return { date: snapToWeekday(addDays(now, 7)), confidence: 'high', basis: 'next week' };
  }
  if (/\bnext quarter\b/.test(p)) {
    return { date: snapToWeekday(nextQuarterStart(now)), confidence: 'high', basis: 'first day of next quarter' };
  }
  if (/\bend of (the )?year\b|\beoy\b/.test(p)) {
    const y = now.getFullYear();
    const eoy = new Date(Date.UTC(y, 11, 15));
    return { date: snapToWeekday(eoy.getTime() <= now.getTime() ? new Date(Date.UTC(y + 1, 11, 15)) : eoy), confidence: 'high', basis: 'mid-December' };
  }
  if (/\bafter the holidays\b/.test(p)) {
    const y = now.getMonth() >= 11 ? now.getFullYear() + 1 : now.getFullYear();
    return { date: snapToWeekday(new Date(Date.UTC(y, 0, 10))), confidence: 'high', basis: 'mid-January' };
  }
  if (/\bend of (the )?month\b|\beom\b/.test(p)) {
    const lastDay = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0));
    return { date: snapToWeekday(lastDay), confidence: 'high', basis: 'end of current month' };
  }

  // 4. Named month — "September", "in March", etc.
  // Loop in case the phrase contains a month name embedded ("circle back in September")
  for (const [name, idx] of Object.entries(MONTHS)) {
    // Word boundary so "may" doesn't match inside "Maya"
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(p)) {
      return { date: snapToWeekday(nextMonth(idx, now)), confidence: 'high', basis: `next upcoming ${name}` };
    }
  }

  // 5. Vague language — low confidence default
  if (/\b(soon|later|sometime|down the line|at some point|in the future)\b/.test(p)) {
    return { date: snapToWeekday(addDays(now, 30)), confidence: 'low', basis: 'vague — default 30 days' };
  }
  if (/\bnext year\b/.test(p)) {
    const next = new Date(Date.UTC(now.getFullYear() + 1, 0, 10));
    return { date: snapToWeekday(next), confidence: 'high', basis: 'early next year' };
  }

  return null;
}
