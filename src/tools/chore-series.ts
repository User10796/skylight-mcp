import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  getChores,
  deleteChore,
  createChoreSeries,
  deleteChoreSeries,
  updateChoreSeriesRecurrence,
} from "../api/endpoints/chores.js";
import { findCategoryByName } from "../api/endpoints/categories.js";
import type { CategoryResource, ChoreResource } from "../api/types.js";
import { getConfig } from "../config.js";
import { getTodayDate, parseDate, parseTime, formatDateForDisplay } from "../utils/dates.js";
import { formatErrorForMcp } from "../utils/errors.js";
import {
  addDays,
  describeRule,
  endOfDayUntil,
  groupChores,
  parseDays,
  planRotation,
  summaryMatches,
  withUntil,
  type ChoreSeries,
} from "../utils/recurrence.js";

const DEFAULT_LOOKAHEAD_DAYS = 90;
const MAX_LOOKAHEAD_DAYS = 365;

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function errorResult(error: unknown) {
  return textResult(formatErrorForMcp(error), true);
}

async function loadWindow(from: string, lookaheadDays: number) {
  const days = Math.min(Math.max(lookaheadDays, 7), MAX_LOOKAHEAD_DAYS);
  const result = await getChores({ after: from, before: addDays(from, days), includeLate: true });
  const names = new Map(result.categories.map((c) => [c.id, c.attributes.label ?? "Unknown"]));
  return { chores: result.chores, names };
}

function assigneeOf(chore: ChoreResource, names: Map<string, string>): string {
  const id = chore.relationships?.category?.data?.id;
  return id ? names.get(id) ?? "Unknown" : "Unassigned";
}

function describeSeries(s: ChoreSeries, names: Map<string, string>): string {
  const who = s.categoryId ? names.get(s.categoryId) ?? "Unknown" : "Unassigned";
  const rule = s.rules.length ? s.rules.map(describeRule).join("; ") : "recurring";
  const next = s.instances
    .filter((i) => i.attributes.status === "pending")
    .slice(0, 3)
    .map((i) => formatDateForDisplay(i.attributes.start));
  return [
    `- "${s.summary}" — ${who}`,
    `  Series ID: ${s.seriesId}`,
    `  Repeats: ${rule}`,
    next.length ? `  Next: ${next.join(", ")}` : `  Next: (none pending in window)`,
  ].join("\n");
}

export function registerChoreSeriesTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // get_chore_series
  // ---------------------------------------------------------------------------
  server.tool(
    "get_chore_series",
    `List recurring chore series (one entry per series, not per day) and spot
one-off chores that repeat by hand.

Use this to answer:
- "What repeating chores do we have?"
- "Who has dishes on rotation?"
- "Why are there so many copies of 'Take out trash'?"

Returns each series with its series ID, assignee, repeat rule, and next dates,
plus any one-off chores whose name appears multiple times (manual copies that
delete_chore_series can clean up).`,
    {
      lookaheadDays: z
        .number()
        .int()
        .optional()
        .describe(`How many days ahead to scan (default ${DEFAULT_LOOKAHEAD_DAYS}, max ${MAX_LOOKAHEAD_DAYS})`),
      assignee: z.string().optional().describe("Only show chores for this family member"),
    },
    async ({ lookaheadDays, assignee }) => {
      try {
        const config = getConfig();
        const today = getTodayDate(config.timezone);
        const { chores, names } = await loadWindow(today, lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS);

        const filtered = assignee
          ? chores.filter((c) => assigneeOf(c, names).toLowerCase().includes(assignee.toLowerCase()))
          : chores;
        const { series, oneOffs } = groupChores(filtered);

        const counts = new Map<string, ChoreResource[]>();
        for (const c of oneOffs) {
          const key = c.attributes.summary.trim().toLowerCase();
          counts.set(key, [...(counts.get(key) ?? []), c]);
        }
        const repeatedOneOffs = [...counts.values()].filter((list) => list.length > 1);

        const sections: string[] = [];
        sections.push(
          series.length
            ? `Recurring series (${series.length}):\n\n${series.map((s) => describeSeries(s, names)).join("\n\n")}`
            : "No recurring chore series found."
        );
        if (repeatedOneOffs.length) {
          sections.push(
            `One-off chores repeated by hand:\n\n` +
              repeatedOneOffs
                .map((list) => {
                  const who = [...new Set(list.map((c) => assigneeOf(c, names)))].join(", ");
                  return `- "${list[0].attributes.summary}" — ${list.length} copies (${who})`;
                })
                .join("\n")
          );
        }
        return textResult(sections.join("\n\n"));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // delete_chore_series
  // ---------------------------------------------------------------------------
  server.tool(
    "delete_chore_series",
    `Remove a repeating chore in one step — the whole series, not one day at a time.

Use this when:
- "Get rid of the dishes rotation"
- "Delete all the 'Take out trash' chores"
- "Stop Cohen's lawn chore starting next week" (mode: "end")

Matches by chore name (or series ID) and handles both true recurring series
and piles of one-off copies with the same name.

Modes:
- "delete" (default): removes every matching series entirely, plus matching
  one-off copies dated on/after \`from\`.
- "end": keeps past occurrences (and their completion history) and stops each
  series after the day before \`from\`. One-off copies on/after \`from\` are deleted.

SAFETY: runs as a preview unless confirm is true. Always show the preview to
the user and get a yes before calling again with confirm: true.`,
    {
      summary: z.string().optional().describe("Chore name to match (case-insensitive)"),
      seriesId: z.string().optional().describe("A specific series ID from get_chore_series"),
      matchMode: z
        .enum(["exact", "contains"])
        .optional()
        .default("exact")
        .describe("How to match the name: 'exact' (default) or 'contains'"),
      assignee: z.string().optional().describe("Only affect chores assigned to this family member"),
      mode: z.enum(["delete", "end"]).optional().default("delete"),
      from: z
        .string()
        .optional()
        .describe("Cutoff date (YYYY-MM-DD, 'today', 'tomorrow', day name). Defaults to today."),
      includeOneOffs: z
        .boolean()
        .optional()
        .default(true)
        .describe("Also remove non-recurring chores with the same name"),
      lookaheadDays: z
        .number()
        .int()
        .optional()
        .describe(`How far ahead to look for one-off copies (default ${DEFAULT_LOOKAHEAD_DAYS}, max ${MAX_LOOKAHEAD_DAYS})`),
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe("false = preview only (default). true = actually delete."),
    },
    async ({ summary, seriesId, matchMode, assignee, mode, from, includeOneOffs, lookaheadDays, confirm }) => {
      try {
        if (!summary && !seriesId) {
          return textResult("Provide a chore name (summary) or a seriesId.", true);
        }
        const config = getConfig();
        const cutoff = from ? parseDate(from, config.timezone) : getTodayDate(config.timezone);
        const { chores, names } = await loadWindow(cutoff, lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS);

        const byAssignee = (c: ChoreResource) =>
          !assignee || assigneeOf(c, names).toLowerCase().includes(assignee.toLowerCase());
        const byName = (c: ChoreResource) =>
          !summary || summaryMatches(c.attributes.summary, summary, matchMode ?? "exact");

        const { series, oneOffs } = groupChores(chores.filter((c) => byAssignee(c) && byName(c)));
        const targetSeries = seriesId ? series.filter((s) => s.seriesId === seriesId) : series;
        const targetOneOffs =
          includeOneOffs && !seriesId ? oneOffs.filter((c) => c.attributes.start >= cutoff) : [];

        if (targetSeries.length === 0 && targetOneOffs.length === 0) {
          return textResult(
            `Nothing matched${summary ? ` "${summary}"` : ""}${seriesId ? ` (series ${seriesId})` : ""}` +
              `${assignee ? ` for ${assignee}` : ""}. Try get_chore_series to see exact names, ` +
              `or matchMode: "contains".`
          );
        }

        const lastDay = addDays(cutoff, -1);
        const plan: string[] = [];
        for (const s of targetSeries) {
          const who = s.categoryId ? names.get(s.categoryId) ?? "Unknown" : "Unassigned";
          const rule = s.rules.length ? s.rules.map(describeRule).join("; ") : "recurring";
          plan.push(
            mode === "end"
              ? `- End series "${s.summary}" (${who}, ${rule}) after ${formatDateForDisplay(lastDay)}`
              : `- Delete entire series "${s.summary}" (${who}, ${rule})`
          );
        }
        if (targetOneOffs.length) {
          const dates = targetOneOffs
            .map((c) => formatDateForDisplay(c.attributes.start))
            .slice(0, 8)
            .join(", ");
          plan.push(
            `- Delete ${targetOneOffs.length} one-off chore(s): ${dates}${targetOneOffs.length > 8 ? ", …" : ""}`
          );
        }

        if (!confirm) {
          return textResult(
            `PREVIEW — nothing has been changed yet.\n\n${plan.join("\n")}\n\n` +
              `Call again with confirm: true to apply.`
          );
        }

        const done: string[] = [];
        const failed: string[] = [];

        for (const s of targetSeries) {
          try {
            if (mode === "end") {
              if (s.rules.length === 0) throw new Error("series has no recurrence rule to end");
              const until = endOfDayUntil(lastDay, config.timezone);
              await updateChoreSeriesRecurrence(s.seriesId, s.rules.map((r) => withUntil(r, until)));
              done.push(`Ended "${s.summary}" after ${formatDateForDisplay(lastDay)}`);
            } else {
              await deleteChoreSeries(s.instances[0].id);
              done.push(`Deleted series "${s.summary}"`);
            }
          } catch (error) {
            failed.push(`"${s.summary}" (series ${s.seriesId}): ${formatErrorForMcp(error)}`);
          }
        }

        let oneOffsDeleted = 0;
        for (const c of targetOneOffs) {
          try {
            await deleteChore(c.id);
            oneOffsDeleted++;
          } catch (error) {
            failed.push(`one-off on ${c.attributes.start}: ${formatErrorForMcp(error)}`);
          }
        }
        if (oneOffsDeleted) done.push(`Deleted ${oneOffsDeleted} one-off chore(s)`);

        const out = [done.length ? done.join("\n") : "No changes were made."];
        if (failed.length) out.push(`\nFailed:\n${failed.join("\n")}`);
        return textResult(out.join("\n"), failed.length > 0 && done.length === 0);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // create_rotating_chore
  // ---------------------------------------------------------------------------
  server.tool(
    "create_rotating_chore",
    `Create a chore that rotates between family members by week — e.g. the boys
alternate weeks on dishes.

Use this when:
- "Cohen and Grayson alternate weeks on dishes, every day"
- "Rotate trash duty Mon/Thu among the three kids, switching weekly"
- "Each kid takes the lawn for two weeks at a time"

Creates a small number of recurring series (one per person, per week of their
turn) using every-N-weeks rules, so the whole rotation can later be removed in
one call with delete_chore_series instead of week by week.

Use dryRun: true to show the schedule without creating anything.`,
    {
      summary: z.string().describe("Chore name (e.g., 'Dishes')"),
      assignees: z
        .array(z.string())
        .min(2)
        .describe("Family members in rotation order; the first one starts"),
      days: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .default("daily")
        .describe("Days the chore happens: 'daily' (default), 'weekdays', 'weekends', or day names like ['Mon','Thu']"),
      rotateEveryWeeks: z
        .number()
        .int()
        .optional()
        .default(1)
        .describe("Weeks each person keeps the chore before handing off (default 1)"),
      startDate: z
        .string()
        .optional()
        .describe("When the rotation begins (YYYY-MM-DD, 'today', day name). The first person owns that week. Defaults to today."),
      time: z.string().optional().describe("Optional time of day (e.g., '7:00 PM')"),
      rewardPoints: z.number().optional().describe("Reward points per completion (Plus)"),
      emoji: z.string().optional().describe("Optional emoji icon"),
      dryRun: z.boolean().optional().default(false).describe("Show the plan without creating anything"),
    },
    async ({ summary, assignees, days, rotateEveryWeeks, startDate, time, rewardPoints, emoji, dryRun }) => {
      try {
        const config = getConfig();
        const start = startDate ? parseDate(startDate, config.timezone) : getTodayDate(config.timezone);
        const dayCodes = parseDays(days ?? "daily");
        const slots = planRotation({
          assigneeCount: assignees.length,
          rotateEveryWeeks: rotateEveryWeeks ?? 1,
          days: dayCodes,
          startDate: start,
        });

        // Resolve every assignee up front so we never create half a rotation.
        const categories: CategoryResource[] = [];
        for (const name of assignees) {
          const category = await findCategoryByName(name);
          if (!category) {
            return textResult(
              `Could not find a family member named "${name}". Use get_family_members to see available names.`,
              true
            );
          }
          categories.push(category);
        }

        const block = rotateEveryWeeks ?? 1;
        const schedule = assignees
          .map((name, i) => {
            const first = slots.filter((s) => s.assigneeIndex === i).map((s) => s.start).sort()[0];
            return `- ${categories[i].attributes.label ?? name}: first turn starts ${formatDateForDisplay(first)}`;
          })
          .join("\n");
        const dayLabel = dayCodes.length === 7 ? "every day" : `on ${dayCodes.join("/")}`;
        const header =
          `"${summary}" ${dayLabel}, rotating every ${block === 1 ? "week" : `${block} weeks`} ` +
          `among ${assignees.length} people (${slots.length} recurring series).`;

        if (dryRun) {
          return textResult(`PLAN (nothing created):\n${header}\n\n${schedule}`);
        }

        const created: string[] = [];
        for (const slot of slots) {
          try {
            const result = await createChoreSeries({
              summary,
              start: slot.start,
              startTime: time ? parseTime(time) : null,
              categoryIds: [categories[slot.assigneeIndex].id],
              recurrenceSet: [slot.rrule],
              rewardPoints: rewardPoints ?? null,
              emojiIcon: emoji ?? null,
            });
            created.push(...result.map((c) => c.id));
          } catch (error) {
            const msg =
              `Created ${created.length} of ${slots.length} series before an error: ${formatErrorForMcp(error)}` +
              (created.length
                ? `\nTo clean up the partial rotation, use delete_chore_series with summary "${summary}".`
                : "");
            return textResult(msg, true);
          }
        }

        return textResult(
          `Created rotation: ${header}\n\n${schedule}\n\n` +
            `To remove it later in one step: delete_chore_series with summary "${summary}".`
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
