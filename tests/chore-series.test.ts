/**
 * Tool-level tests for the chore series tools. These run the real tool
 * handlers and HTTP client against a mocked fetch, and assert that the
 * requests match what the Skylight app itself sends (per skylight-api captures).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

process.env.SKYLIGHT_TOKEN = "test-token";
process.env.SKYLIGHT_FRAME_ID = "999";
process.env.SKYLIGHT_TIMEZONE = "America/New_York";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const handlers = new Map<string, Handler>();
const fakeServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
    handlers.set(name, handler);
  },
};

interface Call {
  method: string;
  url: URL;
  body: unknown;
}
let calls: Call[] = [];

const RULE = ["RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=SU,MO,TU,WE,TH,FR,SA"];
const CATEGORIES = [
  { type: "category", id: "11", attributes: { label: "Cohen" } },
  { type: "category", id: "12", attributes: { label: "Grayson" } },
];

function instance(id: string, start: string, category: string, extra: Record<string, unknown> = {}) {
  return {
    type: "chore",
    id,
    attributes: {
      summary: "Dishes",
      status: "pending",
      start,
      start_time: null,
      recurring: false,
      recurrence_set: null,
      ...extra,
    },
    relationships: { category: { data: { type: "category", id: category } } },
  };
}

const CHORES = [
  instance("500-2026-10-12-0000", "2026-10-12", "11", { recurring: true, group: "500", recurrence_set: RULE }),
  instance("500-2026-10-13-0000", "2026-10-13", "11", { recurring: true, group: "500", recurrence_set: RULE }),
  instance("600-2026-10-19-0000", "2026-10-19", "12", { recurring: true, group: "600", recurrence_set: RULE }),
  instance("701", "2026-10-14", "12"),
  instance("702", "2026-10-21", "12"),
  instance("800", "2026-10-15", "11", { summary: "Trash" }),
];

function respond(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeAll(async () => {
  const { registerChoreSeriesTools } = await import("../src/tools/chore-series.js");
  registerChoreSeriesTools(fakeServer as never);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T16:00:00Z")); // Sat Oct 10, noon Eastern
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname.endsWith("/categories")) return respond({ data: CATEGORIES });
      if (method === "GET" && url.pathname.endsWith("/chores")) return respond({ data: CHORES, included: CATEGORIES });
      if (url.pathname.endsWith("/create_multiple")) {
        const body = (calls.at(-1)!.body ?? {}) as Record<string, unknown>;
        return respond({ data: [instance(String(900 + calls.length), String(body.start), "11")] });
      }
      return respond({});
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const run = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);
const writes = () => calls.filter((c) => c.method !== "GET");

describe("get_chore_series", () => {
  it("lists one entry per series and flags hand-copied one-offs", async () => {
    const res = await run("get_chore_series", {});
    const text = res.content[0].text;
    expect(text).toContain("Recurring series (2)");
    expect(text).toContain("Series ID: 500");
    expect(text).toContain("every other week");
    expect(text).toContain('"Dishes" — 2 copies (Grayson)');
    expect(text).not.toContain("Trash\" —"); // single one-off isn't flagged
  });
});

describe("delete_chore_series", () => {
  it("previews by default and changes nothing", async () => {
    const res = await run("delete_chore_series", { summary: "dishes", matchMode: "exact", mode: "delete", includeOneOffs: true, confirm: false });
    expect(res.content[0].text).toMatch(/^PREVIEW/);
    expect(res.content[0].text).toContain("Delete entire series");
    expect(res.content[0].text).toContain("Delete 2 one-off chore(s)");
    expect(writes()).toHaveLength(0);
  });

  it("deletes each series once with apply_to=all, plus the one-off copies", async () => {
    const res = await run("delete_chore_series", { summary: "Dishes", matchMode: "exact", mode: "delete", includeOneOffs: true, confirm: true });
    expect(res.isError).toBeFalsy();
    const deleted = writes().map((c) => `${c.method} ${c.url.pathname}${c.url.search}`);
    expect(deleted).toEqual([
      "DELETE /api/frames/999/chores/500-2026-10-12-0000?apply_to=all",
      "DELETE /api/frames/999/chores/600-2026-10-19-0000?apply_to=all",
      "DELETE /api/frames/999/chores/701",
      "DELETE /api/frames/999/chores/702",
    ]);
  });

  it("respects the assignee filter", async () => {
    await run("delete_chore_series", { summary: "Dishes", matchMode: "exact", assignee: "Cohen", mode: "delete", includeOneOffs: true, confirm: true });
    expect(writes().map((c) => c.url.pathname)).toEqual(["/api/frames/999/chores/500-2026-10-12-0000"]);
  });

  it("'end' mode adds UNTIL (day before cutoff, local end of day) instead of deleting", async () => {
    await run("delete_chore_series", { seriesId: "500", matchMode: "exact", mode: "end", from: "2026-10-18", includeOneOffs: true, confirm: true });
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].method).toBe("PUT");
    expect(w[0].url.pathname).toBe("/api/frames/999/chores/500");
    expect(w[0].body).toEqual({
      recurring: true,
      recurrence_set: ["RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=SU,MO,TU,WE,TH,FR,SA;UNTIL=20261018T035959Z"],
    });
  });

  it("says so when nothing matches", async () => {
    const res = await run("delete_chore_series", { summary: "Vacuum", matchMode: "exact", mode: "delete", includeOneOffs: true, confirm: true });
    expect(res.content[0].text).toMatch(/Nothing matched/);
    expect(writes()).toHaveLength(0);
  });
});

describe("create_rotating_chore", () => {
  it("dry run creates nothing", async () => {
    const res = await run("create_rotating_chore", {
      summary: "Dishes", assignees: ["Cohen", "Grayson"], days: "daily", rotateEveryWeeks: 1, startDate: "2026-10-11", dryRun: true,
    });
    expect(res.content[0].text).toContain("PLAN");
    expect(res.content[0].text).toContain("Cohen: first turn starts Sun, Oct 11");
    expect(res.content[0].text).toContain("Grayson: first turn starts Sun, Oct 18");
    expect(writes()).toHaveLength(0);
  });

  it("creates one every-other-week series per boy via create_multiple, in the app's format", async () => {
    const res = await run("create_rotating_chore", {
      summary: "Dishes", assignees: ["Cohen", "Grayson"], days: "daily", rotateEveryWeeks: 1,
      startDate: "2026-10-11", time: "7:00 PM", rewardPoints: 2, dryRun: false,
    });
    expect(res.isError).toBeFalsy();
    const posts = writes();
    expect(posts.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/frames/999/chores/create_multiple",
      "POST /api/frames/999/chores/create_multiple",
    ]);
    expect(posts[0].body).toEqual({
      summary: "Dishes",
      start: "2026-10-11",
      start_time: "19:00",
      category_id: "11",
      category_ids: ["11"],
      recurring: true,
      recurrence_set: RULE,
      recurring_until: null,
      routine: false,
      reward_points: 2,
    });
    expect((posts[1].body as Record<string, unknown>).start).toBe("2026-10-18");
    expect((posts[1].body as Record<string, unknown>).category_ids).toEqual(["12"]);
  });

  it("refuses before creating anything if a name is unknown", async () => {
    const res = await run("create_rotating_chore", {
      summary: "Dishes", assignees: ["Cohen", "Bob"], days: "daily", rotateEveryWeeks: 1, dryRun: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"Bob"');
    expect(writes()).toHaveLength(0);
  });
});
