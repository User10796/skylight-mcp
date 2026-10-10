import { getClient } from "../client.js";
import type {
  ChoresResponse,
  ChoreResponse,
  ChoreResource,
  CategoryResource,
  CreateChoreRequest,
  UpdateChoreRequest,
} from "../types.js";

export interface GetChoresOptions {
  after?: string;
  before?: string;
  includeLate?: boolean;
  filterLinkedToProfile?: boolean;
}

export interface GetChoresResult {
  chores: ChoreResource[];
  categories: CategoryResource[];
}

/**
 * Get chores for a date range
 */
export async function getChores(options: GetChoresOptions = {}): Promise<GetChoresResult> {
  const client = getClient();
  const params: Record<string, string | boolean | undefined> = {
    after: options.after,
    before: options.before,
    include_late: options.includeLate,
  };

  if (options.filterLinkedToProfile) {
    params.filter = "linked_to_profile";
  }

  const response = await client.get<ChoresResponse>(
    "/api/frames/{frameId}/chores",
    params
  );

  return {
    chores: response.data,
    categories: response.included ?? [],
  };
}

export interface CreateChoreOptions {
  summary: string;
  start: string;
  startTime?: string;
  status?: string;
  recurring?: boolean;
  recurrenceSet?: string;
  categoryId?: string;
  rewardPoints?: number;
  emojiIcon?: string;
}

/**
 * Create a new chore
 */
export async function createChore(options: CreateChoreOptions): Promise<ChoreResource> {
  const client = getClient();

  const request: CreateChoreRequest = {
    data: {
      type: "chore",
      attributes: {
        summary: options.summary,
        start: options.start,
        start_time: options.startTime ?? null,
        status: options.status ?? "pending",
        recurring: options.recurring ?? false,
        recurrence_set: options.recurrenceSet ?? null,
        reward_points: options.rewardPoints ?? null,
        emoji_icon: options.emojiIcon ?? null,
      },
    },
  };

  // Add category relationship if provided
  if (options.categoryId) {
    request.data.relationships = {
      category: {
        data: {
          type: "category",
          id: options.categoryId,
        },
      },
    };
  }

  const response = await client.post<ChoreResponse>(
    "/api/frames/{frameId}/chores",
    request
  );

  return response.data;
}

export interface UpdateChoreOptions {
  summary?: string;
  start?: string;
  startTime?: string | null;
  status?: string;
  recurring?: boolean;
  recurrenceSet?: string | null;
  categoryId?: string | null;
  rewardPoints?: number | null;
  emojiIcon?: string | null;
}

/**
 * Update an existing chore
 */
export async function updateChore(
  choreId: string,
  options: UpdateChoreOptions
): Promise<ChoreResource> {
  const client = getClient();

  const request: UpdateChoreRequest = {
    data: {
      type: "chore",
      attributes: {},
    },
  };

  // Map options to attributes
  if (options.summary !== undefined) request.data.attributes.summary = options.summary;
  if (options.start !== undefined) request.data.attributes.start = options.start;
  if (options.startTime !== undefined) request.data.attributes.start_time = options.startTime;
  if (options.status !== undefined) request.data.attributes.status = options.status;
  if (options.recurring !== undefined) request.data.attributes.recurring = options.recurring;
  if (options.recurrenceSet !== undefined) request.data.attributes.recurrence_set = options.recurrenceSet;
  if (options.rewardPoints !== undefined) request.data.attributes.reward_points = options.rewardPoints;
  if (options.emojiIcon !== undefined) request.data.attributes.emoji_icon = options.emojiIcon;

  // Handle category relationship
  if (options.categoryId !== undefined) {
    if (options.categoryId === null) {
      request.data.relationships = { category: { data: null } };
    } else {
      request.data.relationships = {
        category: { data: { type: "category", id: options.categoryId } },
      };
    }
  }

  const response = await client.request<ChoreResponse>(
    `/api/frames/{frameId}/chores/${choreId}`,
    { method: "PUT", body: request }
  );

  return response.data;
}

/**
 * Delete a chore
 */
export async function deleteChore(choreId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${choreId}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Series-aware endpoints
//
// These mirror the request shapes the Skylight app itself sends (captured in
// the skylight-api project): flat JSON bodies, `create_multiple` for creation,
// and `apply_to=all` on the dated-instance URL to remove a whole series.
// ---------------------------------------------------------------------------

export interface CreateChoreSeriesOptions {
  summary: string;
  start: string;
  startTime?: string | null;
  categoryIds: string[];
  recurrenceSet?: string[] | null;
  rewardPoints?: number | null;
  emojiIcon?: string | null;
}

/**
 * Create a chore (optionally recurring) the way the Skylight app does:
 * POST /chores/create_multiple. Returns every chore the server created
 * (one per assignee).
 */
export async function createChoreSeries(options: CreateChoreSeriesOptions): Promise<ChoreResource[]> {
  const client = getClient();
  const recurring = Boolean(options.recurrenceSet && options.recurrenceSet.length > 0);

  const body: Record<string, unknown> = {
    summary: options.summary,
    start: options.start,
    start_time: options.startTime ?? null,
    category_ids: options.categoryIds,
    recurring,
    recurrence_set: recurring ? options.recurrenceSet : null,
    recurring_until: null,
    routine: false,
  };
  if (options.categoryIds.length > 0) body.category_id = options.categoryIds[0];
  if (options.rewardPoints != null) body.reward_points = options.rewardPoints;
  if (options.emojiIcon) body.emoji_icon = options.emojiIcon;

  const response = await client.post<{ data: ChoreResource[] | ChoreResource }>(
    "/api/frames/{frameId}/chores/create_multiple",
    body
  );

  const data = response?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

/**
 * Delete an entire recurring series, given the ID of any one of its dated
 * instances (e.g. "55780859-2025-12-29-0600"). Uses apply_to=all, which is
 * what the Skylight app sends for "delete all occurrences".
 */
export async function deleteChoreSeries(instanceId: string): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${encodeURIComponent(instanceId)}`, {
    method: "DELETE",
    params: { apply_to: "all" },
  });
}

/**
 * Replace the recurrence rules on a series (by series ID). Used to end a
 * series on a given date by adding UNTIL to its RRULE, which keeps past
 * (completed) occurrences intact.
 */
export async function updateChoreSeriesRecurrence(
  seriesId: string,
  recurrenceSet: string[]
): Promise<void> {
  const client = getClient();
  await client.request(`/api/frames/{frameId}/chores/${encodeURIComponent(seriesId)}`, {
    method: "PUT",
    body: { recurring: true, recurrence_set: recurrenceSet },
  });
}
