/**
 * Recurrence helpers for chore series and rotations.
 *
 * Skylight stores recurring chores as a single "series" (identified by
 * `attributes.group`) with an RRULE array in `recurrence_set`. The chores
 * endpoint expands each series into dated instances whose IDs look like
 * `<seriesId>-YYYY-MM-DD-HHMM`. Formats below mirror what the Skylight app
 * itself sends (see skylight-api captures), e.g.
 *   RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=TH
 *   RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20260106T045959Z
 */

import type { ChoreResource } from "../api/types.js";

export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

const DAY_ALIASES: Record<string, WeekdayCode> = {
  su: "SU", sun: "SU", sunday: "SU",
  mo: "MO", mon: "MO", monday: "MO",
  tu: "TU", tue: "TU", tues: "TU", tuesday: "TU",
  we: "WE", wed: "WE", wednesday: "WE",
  th: "TH", thu: "TH", thur: "TH", thurs: "TH", thursday: "TH",
  fr: "FR", fri: "FR", friday: "FR",
  sa: "SA", sat: "SA", saturday: "SA",
};

/**
 * Parse a day specification into sorted RRULE weekday codes.
 * Accepts "daily", "weekdays", "weekends", or a list / comma string of day names.
 */
export function parseDays(input: string | string[]): WeekdayCode[] {
  const tokens = (Array.isArray(input) ? input : input.split(/[,\s]+/))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const result = new Set<WeekdayCode>();
  for (const token of tokens) {
    if (token === "daily" || token === "everyday" || token === "all") {
      WEEKDAY_CODES.forEach((d) => result.add(d));
    } else if (token === "weekdays") {
      (["MO", "TU", "WE", "TH", "FR"] as WeekdayCode[]).forEach((d) => result.add(d));
    } else if (token === "weekends") {
      result.add("SA");
      result.add("SU");
    } else if (DAY_ALIASES[token]) {
      result.add(DAY_ALIASES[token]);
    } else {
      throw new Error(`Unrecognized day "${token}". Use day names (e.g. "Mon, Wed"), "daily", "weekdays", or "weekends".`);
    }
  }
  if (result.size === 0) {
    throw new Error("At least one day is required.");
  }
  return WEEKDAY_CODES.filter((d) => result.has(d));
}

function toUtcDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = toUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtcDate(d);
}

/** RRULE weekday code for a YYYY-MM-DD date. */
export function dayCodeOf(date: string): WeekdayCode {
  return WEEKDAY_CODES[toUtcDate(date).getUTCDay()];
}

/** The Sunday that starts the week containing `date` (Skylight uses WKST=SU). */
export function weekStartOf(date: string): string {
  return addDays(date, -toUtcDate(date).getUTCDay());
}

export interface RotationSlot {
  /** Index into the assignee list */
  assigneeIndex: number;
  /** First occurrence date (YYYY-MM-DD) — used as the series start */
  start: string;
  /** RRULE string for this slot's series */
  rrule: string;
}

export interface RotationPlanInput {
  assigneeCount: number;
  /** How many consecutive weeks each person holds the chore (default 1) */
  rotateEveryWeeks?: number;
  days: WeekdayCode[];
  /** Date the rotation begins; the first assignee owns the week containing it */
  startDate: string;
}

/**
 * Plan a weekly rotation as a small set of recurring series.
 *
 * Each assignee gets one series per week of their block, each recurring every
 * `assigneeCount * rotateEveryWeeks` weeks on the chosen days. Two boys
 * alternating weekly on a daily chore = 2 series total, instead of a new chore
 * every week.
 */
export function planRotation(input: RotationPlanInput): RotationSlot[] {
  const { assigneeCount, days, startDate } = input;
  const blockWeeks = input.rotateEveryWeeks ?? 1;

  if (!Number.isInteger(assigneeCount) || assigneeCount < 1) {
    throw new Error("A rotation needs at least one assignee.");
  }
  if (!Number.isInteger(blockWeeks) || blockWeeks < 1 || blockWeeks > 8) {
    throw new Error("rotateEveryWeeks must be a whole number between 1 and 8.");
  }

  const cycleWeeks = assigneeCount * blockWeeks;
  const rrule = `RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=${cycleWeeks};BYDAY=${days.join(",")}`;
  const anchor = weekStartOf(startDate);
  const slots: RotationSlot[] = [];

  for (let a = 0; a < assigneeCount; a++) {
    for (let w = 0; w < blockWeeks; w++) {
      let weekStart = addDays(anchor, 7 * (a * blockWeeks + w));
      let first = firstMatchingDay(weekStart, days, startDate);
      if (!first) {
        // No eligible day left in this week (start date is late in the week):
        // this slot's first turn comes one full cycle later.
        weekStart = addDays(weekStart, 7 * cycleWeeks);
        first = firstMatchingDay(weekStart, days, startDate)!;
      }
      slots.push({ assigneeIndex: a, start: first, rrule });
    }
  }

  return slots;
}

function firstMatchingDay(weekStart: string, days: WeekdayCode[], notBefore: string): string | null {
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    if (date >= notBefore && days.includes(dayCodeOf(date))) {
      return date;
    }
  }
  return null;
}

/**
 * UTC timestamp (RRULE UNTIL format, e.g. 20260106T045959Z) for 23:59:59 local
 * time on `date` in `timezone`. Matches how the Skylight app ends series.
 */
export function endOfDayUntil(date: string, timezone: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, 23, 59, 59);
  const offsetMs = timezoneOffsetMs(naiveUtc, timezone);
  const instant = new Date(naiveUtc - offsetMs);
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Offset of `timezone` from UTC at the given instant, in ms (e.g. -4h for EDT). */
function timezoneOffsetMs(instantMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return localAsUtc - instantMs;
}

/** Replace any UNTIL/COUNT in an RRULE with the given UNTIL. */
export function withUntil(rrule: string, until: string): string {
  const [prefix, body = ""] = rrule.includes(":") ? rrule.split(/:(.*)/s) : ["RRULE", rrule];
  const parts = body
    .split(";")
    .filter((p) => p && !/^(UNTIL|COUNT)=/i.test(p));
  parts.push(`UNTIL=${until}`);
  return `${prefix}:${parts.join(";")}`;
}

/** Normalize Skylight's recurrence_set (array, string, or null) to an array. */
export function toRuleArray(recurrenceSet: string | string[] | null | undefined): string[] {
  if (!recurrenceSet) return [];
  return Array.isArray(recurrenceSet) ? recurrenceSet : [recurrenceSet];
}

/** Series ID for a chore instance (`group`, falling back to the ID prefix). */
export function seriesIdOf(chore: ChoreResource): string {
  const group = chore.attributes.group;
  if (group !== undefined && group !== null && String(group) !== "") {
    return String(group);
  }
  return String(chore.id).split("-")[0];
}

export interface ChoreSeries {
  seriesId: string;
  summary: string;
  categoryId: string | null;
  rules: string[];
  instances: ChoreResource[];
}

export interface GroupedChores {
  series: ChoreSeries[];
  oneOffs: ChoreResource[];
}

/** Split a list of chore instances into recurring series and one-off chores. */
export function groupChores(chores: ChoreResource[]): GroupedChores {
  const seriesMap = new Map<string, ChoreSeries>();
  const oneOffs: ChoreResource[] = [];

  for (const chore of chores) {
    if (!chore.attributes.recurring) {
      oneOffs.push(chore);
      continue;
    }
    const id = seriesIdOf(chore);
    let entry = seriesMap.get(id);
    if (!entry) {
      entry = {
        seriesId: id,
        summary: chore.attributes.summary,
        categoryId: chore.relationships?.category?.data?.id ?? null,
        rules: toRuleArray(chore.attributes.recurrence_set),
        instances: [],
      };
      seriesMap.set(id, entry);
    }
    entry.instances.push(chore);
  }

  for (const s of seriesMap.values()) {
    s.instances.sort((a, b) => a.attributes.start.localeCompare(b.attributes.start));
  }

  return {
    series: [...seriesMap.values()].sort((a, b) => a.summary.localeCompare(b.summary)),
    oneOffs,
  };
}

/** Case-insensitive summary match. */
export function summaryMatches(summary: string, query: string, mode: "exact" | "contains"): boolean {
  const a = summary.trim().toLowerCase();
  const b = query.trim().toLowerCase();
  return mode === "exact" ? a === b : a.includes(b);
}

/** Short human description of an RRULE, falling back to the raw rule. */
export function describeRule(rule: string): string {
  const body = rule.replace(/^RRULE:/i, "");
  const fields = Object.fromEntries(
    body.split(";").filter(Boolean).map((p) => {
      const [k, v] = p.split("=");
      return [k.toUpperCase(), v];
    })
  );
  const interval = Number(fields.INTERVAL ?? 1);
  const freq = fields.FREQ;
  let text: string;
  if (freq === "DAILY") {
    text = interval === 1 ? "every day" : `every ${interval} days`;
  } else if (freq === "WEEKLY") {
    const days = fields.BYDAY ? fields.BYDAY.split(",").join("/") : "";
    const every = interval === 1 ? "every week" : interval === 2 ? "every other week" : `every ${interval} weeks`;
    text = days ? `${every} on ${days}` : every;
  } else if (freq === "MONTHLY") {
    text = interval === 1 ? "every month" : `every ${interval} months`;
  } else if (freq === "YEARLY") {
    text = "every year";
  } else {
    return rule;
  }
  if (fields.UNTIL) {
    text += ` until ${fields.UNTIL.slice(0, 4)}-${fields.UNTIL.slice(4, 6)}-${fields.UNTIL.slice(6, 8)}`;
  }
  return text;
}
