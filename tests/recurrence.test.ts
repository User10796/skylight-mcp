import { describe, it, expect } from "vitest";
import {
  addDays,
  dayCodeOf,
  weekStartOf,
  parseDays,
  planRotation,
  endOfDayUntil,
  withUntil,
  groupChores,
  describeRule,
  summaryMatches,
} from "../src/utils/recurrence.js";
import type { ChoreResource } from "../src/api/types.js";

describe("date helpers", () => {
  it("adds days across month boundaries", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("finds weekday codes and Sunday week starts", () => {
    expect(dayCodeOf("2026-10-10")).toBe("SA");
    expect(weekStartOf("2026-10-10")).toBe("2026-10-04");
    expect(weekStartOf("2026-10-11")).toBe("2026-10-11");
  });
});

describe("parseDays", () => {
  it("expands keywords", () => {
    expect(parseDays("daily")).toEqual(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
    expect(parseDays("weekdays")).toEqual(["MO", "TU", "WE", "TH", "FR"]);
    expect(parseDays("weekends")).toEqual(["SU", "SA"]);
  });

  it("parses day names in any order and format", () => {
    expect(parseDays(["Thursday", "mon"])).toEqual(["MO", "TH"]);
    expect(parseDays("Tue, Fri")).toEqual(["TU", "FR"]);
  });

  it("rejects nonsense", () => {
    expect(() => parseDays("funday")).toThrow(/Unrecognized day/);
  });
});

describe("planRotation", () => {
  it("two people alternating weekly on a daily chore = 2 series, every other week", () => {
    // Sunday Oct 11 2026
    const slots = planRotation({ assigneeCount: 2, days: parseDays("daily"), startDate: "2026-10-11" });
    expect(slots).toEqual([
      { assigneeIndex: 0, start: "2026-10-11", rrule: "RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=SU,MO,TU,WE,TH,FR,SA" },
      { assigneeIndex: 1, start: "2026-10-18", rrule: "RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=SU,MO,TU,WE,TH,FR,SA" },
    ]);
  });

  it("starts mid-week for the first person and on Sunday for the next", () => {
    // Wednesday Oct 14
    const slots = planRotation({ assigneeCount: 2, days: parseDays("daily"), startDate: "2026-10-14" });
    expect(slots.map((s) => s.start)).toEqual(["2026-10-14", "2026-10-18"]);
  });

  it("anchors each series on the first chosen weekday of its week", () => {
    const slots = planRotation({ assigneeCount: 3, days: parseDays(["Mon", "Thu"]), startDate: "2026-10-11" });
    expect(slots.map((s) => s.start)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(slots[0].rrule).toBe("RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=3;BYDAY=MO,TH");
  });

  it("pushes the first person's turn a full cycle when no eligible day remains that week", () => {
    // Friday Oct 16, chore only on Mondays: person 0's first Monday in their week has passed
    const slots = planRotation({ assigneeCount: 2, days: parseDays(["Mon"]), startDate: "2026-10-16" });
    expect(slots.map((s) => [s.assigneeIndex, s.start])).toEqual([
      [0, "2026-10-26"],
      [1, "2026-10-19"],
    ]);
  });

  it("supports multi-week blocks with one series per week of the block", () => {
    const slots = planRotation({
      assigneeCount: 2,
      rotateEveryWeeks: 2,
      days: parseDays("daily"),
      startDate: "2026-10-11",
    });
    expect(slots.map((s) => [s.assigneeIndex, s.start])).toEqual([
      [0, "2026-10-11"],
      [0, "2026-10-18"],
      [1, "2026-10-25"],
      [1, "2026-11-01"],
    ]);
    expect(slots.every((s) => s.rrule.includes("INTERVAL=4"))).toBe(true);
  });
});

describe("endOfDayUntil / withUntil", () => {
  it("matches the Skylight app's UNTIL format (local end of day in UTC)", () => {
    // Captured from the app: UNTIL=20260106T045959Z == Jan 5 23:59:59 EST
    expect(endOfDayUntil("2026-01-05", "America/New_York")).toBe("20260106T045959Z");
    // Daylight time
    expect(endOfDayUntil("2026-10-17", "America/New_York")).toBe("20261018T035959Z");
  });

  it("adds or replaces UNTIL and drops COUNT", () => {
    expect(withUntil("RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=TH", "20261018T035959Z")).toBe(
      "RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=TH;UNTIL=20261018T035959Z"
    );
    expect(withUntil("RRULE:FREQ=DAILY;UNTIL=20250101T000000Z;COUNT=4", "20261018T035959Z")).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20261018T035959Z"
    );
  });
});

function chore(id: string, overrides: Partial<ChoreResource["attributes"]> = {}, categoryId = "1"): ChoreResource {
  return {
    type: "chore",
    id,
    attributes: {
      summary: "Dishes",
      status: "pending",
      start: "2026-10-12",
      start_time: null,
      completed_on: null,
      is_future: null,
      recurring: false,
      recurring_until: null,
      recurrence_set: null,
      reward_points: null,
      emoji_icon: null,
      routine: false,
      position: 1,
      ...overrides,
    },
    relationships: { category: { data: { type: "category", id: categoryId } } },
  };
}

describe("groupChores", () => {
  it("collapses dated instances into series and keeps one-offs separate", () => {
    const rule = ["RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=MO"];
    const grouped = groupChores([
      chore("500-2026-10-26-0000", { recurring: true, group: "500", recurrence_set: rule, start: "2026-10-26" }),
      chore("500-2026-10-12-0000", { recurring: true, group: "500", recurrence_set: rule, start: "2026-10-12" }),
      chore("600-2026-10-19-0000", { recurring: true, recurrence_set: rule, start: "2026-10-19" }, "2"),
      chore("700", { start: "2026-10-13" }),
    ]);
    expect(grouped.series.map((s) => [s.seriesId, s.instances.length])).toEqual([
      ["500", 2],
      ["600", 1], // falls back to the ID prefix when group is missing
    ]);
    expect(grouped.series[0].instances[0].attributes.start).toBe("2026-10-12");
    expect(grouped.oneOffs.map((c) => c.id)).toEqual(["700"]);
  });
});

describe("describeRule / summaryMatches", () => {
  it("describes common rules", () => {
    expect(describeRule("RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=TH")).toBe("every other week on TH");
    expect(describeRule("RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=6")).toBe("every day");
    expect(describeRule("RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH")).toBe("every 3 weeks on MO/TH");
  });

  it("matches names exactly or by substring, case-insensitively", () => {
    expect(summaryMatches(" Dishes ", "dishes", "exact")).toBe(true);
    expect(summaryMatches("Unload dishes", "dishes", "exact")).toBe(false);
    expect(summaryMatches("Unload dishes", "DISHES", "contains")).toBe(true);
  });
});
