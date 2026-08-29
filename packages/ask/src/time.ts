/**
 * Turning "vendredi après-midi" into a window (SEARCH §3).
 *
 * Most questions about memory are time-shaped, so this is the layer that decides whether Ask feels
 * like it understands you. Three rules from the specification are load-bearing and are what the tests
 * are mostly about:
 *
 *   - **The work day starts at 04:00 local, not at midnight.** A commit at 01:30 belongs to the
 *     evening you remember it from. This matches `workDay` in `@rewind/predict` and the store.
 *   - **Resolve against the timezone the events were captured in**, never the one the question is
 *     asked in (TR-8). The offset travels with the events; a flight must not move a memory.
 *   - **Explicit expressions filter, vague ones only rank.** An empty result set produced by reading
 *     too much into "récemment" is a worse failure than a mis-ordered list, because the reader
 *     concludes the data is not there rather than that the query was loose.
 *
 * French and English are both first-class here. The product is French-first with an English toggle
 * (§147) and nobody switches the interface language before typing a question.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Local milliseconds past midnight at which one work day becomes the next. */
const CUTOFF = 4 * HOUR;

export interface TimeWindow {
  /** Inclusive, epoch milliseconds. */
  from: number;
  /** Exclusive, epoch milliseconds. */
  to: number;
  /**
   * The user's own words that produced this window, verbatim.
   *
   * Quoted back rather than described, for two reasons: it is not engine prose, so it needs no
   * translation (§147), and showing the reader the words their window came from is what makes a
   * wrong reading correctable instead of mysterious.
   */
  expression: string;
  /** Explicit expressions are hard filters; vague ones are ranking boosts only. */
  hard: boolean;
  /** True when the phrase has more than one honest reading — "vendredi dernier" on a Saturday. */
  ambiguous: boolean;
}

export interface TimeOptions {
  /**
   * The hour lunch starts, for "avant le déjeuner".
   *
   * Passed in rather than assumed: the specification wants it inferred from the reader's own longest
   * midday gap, and `lunchHour` in `index.ts` does exactly that. 12 is the fallback for someone with
   * too little history to have a habit yet.
   */
  lunchHour?: number;
}

const WEEKDAYS: Record<string, number> = {
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  janvier: 0,
  fevrier: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11,
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/** Parts of a day, as local hours: `[from, to)`. Night wraps past midnight and is handled apart. */
const PARTS: Record<string, { from: number; to: number }> = {
  morning: { from: 5, to: 12 },
  afternoon: { from: 12, to: 18 },
  evening: { from: 18, to: 23 },
  night: { from: 23, to: 29 },
};

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Which work day a moment belongs to, counted from the epoch. */
function dayIndex(localMs: number): number {
  return Math.floor((localMs - CUTOFF) / DAY);
}

/** Local milliseconds at which a work day begins. */
function dayStart(index: number): number {
  return index * DAY + CUTOFF;
}

/** Calendar weekday of a work day, 0 = Sunday. */
function weekdayOf(index: number): number {
  return new Date(dayStart(index)).getUTCDay();
}

/** A window covering whole work days, converted back out of local time. */
function daysWindow(
  firstIndex: number,
  lastIndex: number,
  tz: number,
  expression: string,
  ambiguous = false,
): TimeWindow {
  const shift = tz * 60_000;
  return {
    from: dayStart(firstIndex) - shift,
    to: dayStart(lastIndex + 1) - shift,
    expression,
    hard: true,
    ambiguous,
  };
}

/**
 * The window a question refers to, or null when it refers to no particular time.
 *
 * Matching is ordered from most specific to least: an absolute date beats a weekday, a weekday beats
 * a range, and the vague boost is only reached when nothing explicit matched. Only the first match
 * counts — "hier et lundi dernier" is a compound nobody types, and guessing at compounds is how a
 * resolver starts inventing windows the reader did not ask for.
 */
export function resolveTime(
  query: string,
  now: number,
  tz: number,
  options: TimeOptions = {},
): TimeWindow | null {
  const text = fold(query);
  const shift = tz * 60_000;
  const today = dayIndex(now + shift);

  const part = matchPart(text);
  const day = matchDay(text, today);

  if (day) {
    const window = part ? applyPart(day.index, day.index, part.key, tz) : null;
    const expression = part ? `${day.expression} ${part.expression}` : day.expression;
    return window
      ? { ...window, expression, ambiguous: day.ambiguous }
      : daysWindow(day.index, day.index, tz, expression, day.ambiguous);
  }

  // A part of day with no day named means today's — "ce matin", "this afternoon".
  if (part) {
    const window = applyPart(today, today, part.key, tz);
    return { ...window, expression: part.expression };
  }

  const meal = matchMeal(text, today, tz, options.lunchHour ?? 12);
  if (meal) return meal;

  const range = matchRange(text, today, tz, now);
  if (range) return range;

  const absolute = matchAbsolute(text, now, tz);
  if (absolute) return absolute;

  const vague = /\b(recemment|dernierement|ces derniers temps|recently|lately|a while ago)\b/.exec(
    text,
  );
  if (vague) {
    // Soft: it moves ranking, it never removes a result. Fourteen days is the same τ the recency
    // term already decays over, so "recently" boosts exactly the span recency already prefers.
    return {
      from: now - 14 * DAY,
      to: now + DAY,
      expression: vague[0],
      hard: false,
      ambiguous: false,
    };
  }

  return null;
}

function matchPart(text: string): { key: keyof typeof PARTS; expression: string } | null {
  const table: [RegExp, keyof typeof PARTS][] = [
    [/\b(matin|matinee|morning)\b/, 'morning'],
    [/\b(apres-midi|apres midi|afternoon)\b/, 'afternoon'],
    [/\b(soir|soiree|evening|tonight)\b/, 'evening'],
    [/\b(nuit|night)\b/, 'night'],
  ];
  for (const [pattern, key] of table) {
    const found = pattern.exec(text);
    if (found) return { key, expression: found[0] };
  }
  return null;
}

/**
 * Narrow whole days down to a part of them.
 *
 * Night is the awkward one: it runs from 23:00 to 05:00 the following morning, which crosses the
 * work-day cutoff. Expressing it as hours 23–29 of the same day and letting the arithmetic carry is
 * simpler than special-casing it, and it lands where a reader means: "cette nuit" covers the small
 * hours that the 04:00 cutoff has already filed under the evening before.
 */
function applyPart(
  firstIndex: number,
  lastIndex: number,
  key: keyof typeof PARTS,
  tz: number,
): TimeWindow {
  const shift = tz * 60_000;
  const { from, to } = PARTS[key]!;
  // Hours are counted from calendar midnight, while a work day starts at 04:00 — so 05:00 is one
  // hour into the day, and 02:00 is twenty-two hours into the previous one.
  const midnight = dayStart(firstIndex) - CUTOFF;
  const lastMidnight = dayStart(lastIndex) - CUTOFF;
  return {
    from: midnight + from * HOUR - shift,
    to: lastMidnight + to * HOUR - shift,
    expression: '',
    hard: true,
    ambiguous: false,
  };
}

function matchDay(
  text: string,
  today: number,
): { index: number; expression: string; ambiguous: boolean } | null {
  const named: [RegExp, number][] = [
    [/\bavant-hier\b|\bthe day before yesterday\b/, -2],
    [/\bhier\b|\byesterday\b/, -1],
    [/\baujourd'?hui\b|\btoday\b/, 0],
  ];
  for (const [pattern, offset] of named) {
    const found = pattern.exec(text);
    if (found) return { index: today + offset, expression: found[0], ambiguous: false };
  }

  const ago = /\bil y a (\d+) jours?\b|\b(\d+) days? ago\b/.exec(text);
  if (ago) {
    const count = Number(ago[1] ?? ago[2]);
    if (Number.isFinite(count) && count >= 0 && count < 3650) {
      return { index: today - count, expression: ago[0], ambiguous: false };
    }
  }

  const weekday = new RegExp(`\\b(${Object.keys(WEEKDAYS).join('|')})\\b( dernier)?`).exec(text);
  if (weekday) {
    const wanted = WEEKDAYS[weekday[1]!]!;
    const explicitlyLast = Boolean(weekday[2]) || /\blast\s*$/.test(text.slice(0, weekday.index));
    // The most recent occurrence, today included: on a Friday, "vendredi" is today.
    let index = today;
    while (weekdayOf(index) !== wanted) index -= 1;

    let ambiguous = false;
    if (explicitlyLast) {
      // Said on a Friday, "vendredi dernier" is never today — it is the Friday a week back.
      if (index === today) index -= 7;
      // Said on a Saturday it means either yesterday or the Friday before, and both readings are
      // honest. Take the nearer one and declare the ambiguity rather than resolving it silently;
      // on a Wednesday there is nothing to declare, since only one Friday has happened this week.
      else if (today - index <= todayWeekOffset(today)) ambiguous = true;
    }

    const start = weekday.index;
    return { index, expression: text.slice(start, start + weekday[0]!.length), ambiguous };
  }

  return null;
}

/** How many days into the current week (Monday-based) today is. */
function todayWeekOffset(today: number): number {
  return (weekdayOf(today) + 6) % 7;
}

function matchMeal(text: string, today: number, tz: number, lunchHour: number): TimeWindow | null {
  const shift = tz * 60_000;
  const midnight = dayStart(today) - CUTOFF;
  const before = /\bavant (le )?dejeuner\b|\bbefore lunch\b/.exec(text);
  if (before) {
    return {
      from: midnight + 5 * HOUR - shift,
      to: midnight + lunchHour * HOUR - shift,
      expression: before[0],
      hard: true,
      ambiguous: false,
    };
  }
  const after = /\bapres (le )?dejeuner\b|\bafter lunch\b/.exec(text);
  if (after) {
    return {
      from: midnight + (lunchHour + 1) * HOUR - shift,
      to: dayStart(today + 1) - shift,
      expression: after[0],
      hard: true,
      ambiguous: false,
    };
  }
  return null;
}

function matchRange(text: string, today: number, tz: number, now: number): TimeWindow | null {
  const monday = today - todayWeekOffset(today);

  const lastWeek = /\bla semaine derniere\b|\blast week\b/.exec(text);
  if (lastWeek) return daysWindow(monday - 7, monday - 1, tz, lastWeek[0]);

  const thisWeek = /\bcette semaine\b|\bthis week\b/.exec(text);
  if (thisWeek) return daysWindow(monday, today, tz, thisWeek[0]);

  const lastN = /\b(?:ces |les )?(\d+) derniers jours\b|\blast (\d+) days\b/.exec(text);
  if (lastN) {
    const count = Number(lastN[1] ?? lastN[2]);
    if (Number.isFinite(count) && count > 0 && count < 3650) {
      return daysWindow(today - count + 1, today, tz, lastN[0]);
    }
  }

  const shift = tz * 60_000;
  const nowLocal = new Date(now + shift);
  const monthStart = (year: number, month: number) => Date.UTC(year, month, 1) + CUTOFF - shift;

  const lastMonth = /\ble mois dernier\b|\blast month\b/.exec(text);
  if (lastMonth) {
    return {
      from: monthStart(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth() - 1),
      to: monthStart(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth()),
      expression: lastMonth[0],
      hard: true,
      ambiguous: false,
    };
  }

  const thisMonth = /\bce mois-ci\b|\bce mois\b|\bthis month\b/.exec(text);
  if (thisMonth) {
    return {
      from: monthStart(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth()),
      to: dayStart(today + 1) - shift,
      expression: thisMonth[0],
      hard: true,
      ambiguous: false,
    };
  }

  return null;
}

/**
 * An explicit date: `2026-03-12`, `12 mars`, `march 12`.
 *
 * A bare day-and-month with no year means the most recent one that has already happened. Reading it
 * as a future date would return nothing, and nobody asks a memory about next March.
 */
function matchAbsolute(text: string, now: number, tz: number): TimeWindow | null {
  const shift = tz * 60_000;

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) {
    const local = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    const index = dayIndex(local + CUTOFF);
    return daysWindow(index, index, tz, iso[0]);
  }

  const names = Object.keys(MONTHS).join('|');
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:er)? (${names})\\b`).exec(text);
  const monthFirst = new RegExp(`\\b(${names}) (\\d{1,2})\\b`).exec(text);
  const found = dayFirst
    ? { day: Number(dayFirst[1]), month: MONTHS[dayFirst[2]!]!, text: dayFirst[0] }
    : monthFirst
      ? { day: Number(monthFirst[2]), month: MONTHS[monthFirst[1]!]!, text: monthFirst[0] }
      : null;
  if (!found || found.day < 1 || found.day > 31) return null;

  const nowLocal = new Date(now + shift);
  let year = nowLocal.getUTCFullYear();
  if (Date.UTC(year, found.month, found.day) > now + shift) year -= 1;
  const index = dayIndex(Date.UTC(year, found.month, found.day) + CUTOFF);
  return daysWindow(index, index, tz, found.text);
}

/**
 * The work day a moment belongs to, as `YYYY-MM-DD`.
 *
 * The same 04:00 cutoff as `work_day` in the store and `workDay` in the prediction layer. Three
 * implementations of one rule is two too many, and they will be one when the engine is ported; until
 * then they are kept identical on purpose and each says so.
 */
export function workDayOf(timestamp: number, tzOffsetMinutes: number): string {
  return new Date(timestamp + tzOffsetMinutes * 60_000 - CUTOFF).toISOString().slice(0, 10);
}

/** Whether a moment falls inside a window. Half-open, so adjacent windows cannot both claim it. */
export function within(window: TimeWindow, timestamp: number): boolean {
  return timestamp >= window.from && timestamp < window.to;
}

/**
 * When this person stops for lunch, counted rather than assumed (SEARCH §3).
 *
 * The longest gap in each day's activity between 11:00 and 15:00, taken as a median across days.
 * "Avant le déjeuner" then means before *their* lunch — which for one reader is 11:30 and for
 * another 13:30, and the difference is two hours of the wrong afternoon.
 *
 * Three days of history is the floor, and below it this returns the 12:00 default rather than
 * generalising from one Tuesday. That is the same withholding rule the prediction layer runs on: a
 * habit inferred from a single observation is not a habit.
 */
export function lunchHour(session: {
  events: { timestamp: number }[];
  tzOffsetMinutes: number;
}): number {
  const shift = session.tzOffsetMinutes * 60_000;
  const byDay = new Map<number, number[]>();
  for (const event of session.events) {
    const local = event.timestamp + shift;
    const list = byDay.get(dayIndex(local)) ?? [];
    list.push(local);
    byDay.set(dayIndex(local), list);
  }

  const observed: number[] = [];
  for (const [index, times] of byDay) {
    const midnight = dayStart(index) - CUTOFF;
    const sorted = [...times].sort((a, b) => a - b);
    let bestGap = 0;
    let bestHour = -1;
    for (let i = 1; i < sorted.length; i += 1) {
      const start = sorted[i - 1]!;
      const hour = (start - midnight) / HOUR;
      if (hour < 11 || hour >= 15) continue;
      const gap = sorted[i]! - start;
      if (gap > bestGap) {
        bestGap = gap;
        bestHour = Math.floor(hour);
      }
    }
    // Under twenty minutes is a pause between two windows, not a meal.
    if (bestHour >= 0 && bestGap >= 20 * 60_000) observed.push(bestHour);
  }

  if (observed.length < 3) return 12;
  observed.sort((a, b) => a - b);
  return observed[Math.floor(observed.length / 2)]!;
}
