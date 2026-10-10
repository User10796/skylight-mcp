/**
 * Tests for the OAuth login flow and the client's auth handling, against a
 * mocked fetch that behaves like Skylight's Rails auth endpoints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { login, refreshLogin, deviceFingerprint } from "../src/api/auth.js";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}
let calls: Call[] = [];

function res(status: number, body = "", headers: Record<string, string> = {}, cookies: string[] = []) {
  const h = new Headers(headers);
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(status === 204 || status === 302 ? null : body, { status, headers: h });
}

/** A fake Skylight auth server. `goodPassword` decides whether login succeeds. */
function fakeSkylight(goodPassword: string) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, url, headers, body });

    if (url.pathname === "/auth/session/new") {
      return res(
        200,
        `<html><meta name="csrf-token" content="meta-tok"><form><input type="hidden" name="authenticity_token" value="csrf&#43;tok=="></form></html>`,
        { "content-type": "text/html" },
        ["_skylight_session=s1; path=/; HttpOnly"]
      );
    }
    if (url.pathname === "/auth/session" && method === "POST") {
      const form = new URLSearchParams(body);
      const ok = form.get("password") === goodPassword && headers.Cookie?.includes("_skylight_session=s1");
      return ok
        ? res(302, "", { location: "https://app.ourskylight.com/" }, ["_skylight_session=s2; path=/"])
        : res(302, "", { location: "https://app.ourskylight.com/auth/session/new" });
    }
    if (url.pathname === "/oauth/authorize") {
      return headers.Cookie?.includes("_skylight_session=s2")
        ? res(302, "", { location: "https://ourskylight.com/welcome?code=the-code" })
        : res(302, "", { location: "https://app.ourskylight.com/auth/session/new" });
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code" && form.get("code") === "the-code") {
        return res(200, JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 7200 }));
      }
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "refresh-1") {
        return res(200, JSON.stringify({ access_token: "access-2", expires_in: 7200 }));
      }
      return res(400, JSON.stringify({ error: "invalid_grant" }));
    }
    return res(404, "not found");
  });
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SKYLIGHT_DEVICE_FINGERPRINT;
});

describe("login (OAuth flow)", () => {
  it("walks login page → form → authorize → token and returns the tokens", async () => {
    vi.stubGlobal("fetch", fakeSkylight("right"));
    const result = await login("dad@example.com", "right");
    expect(result).toEqual({
      email: "dad@example.com",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 7200,
    });

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /auth/session/new",
      "POST /auth/session",
      "GET /oauth/authorize",
      "POST /oauth/token",
    ]);
    // CSRF token is HTML-decoded and posted with the credentials
    const form = new URLSearchParams(calls[1].body);
    expect(form.get("authenticity_token")).toBe("csrf+tok==");
    expect(form.get("email")).toBe("dad@example.com");
    // OAuth params match the mobile client
    const auth = calls[2].url.searchParams;
    expect(auth.get("client_id")).toBe("skylight-mobile");
    expect(auth.get("scope")).toBe("everything");
    expect(auth.get("skylight_api_client_device_fingerprint")).toBe(deviceFingerprint("dad@example.com"));
  });

  it("reports a wrong password clearly", async () => {
    vi.stubGlobal("fetch", fakeSkylight("right"));
    await expect(login("dad@example.com", "wrong")).rejects.toThrow(/Invalid email or password/);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/auth/session/new", "/auth/session"]);
  });

  it("refreshes with the refresh token and keeps it when none is returned", async () => {
    vi.stubGlobal("fetch", fakeSkylight("right"));
    const result = await refreshLogin("dad@example.com", "refresh-1");
    expect(result.accessToken).toBe("access-2");
    expect(result.refreshToken).toBe("refresh-1");
  });
});

describe("deviceFingerprint", () => {
  it("is stable per account, UUID-shaped, and overridable", () => {
    const a = deviceFingerprint("Dad@Example.com");
    expect(a).toBe(deviceFingerprint("dad@example.com"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(deviceFingerprint("mom@example.com"));
    process.env.SKYLIGHT_DEVICE_FINGERPRINT = "fixed-id";
    expect(deviceFingerprint("dad@example.com")).toBe("fixed-id");
  });
});

describe("SkylightClient with email/password auth", () => {
  it("sends Bearer + api-version headers and renews the session after a 401", async () => {
    vi.resetModules();
    process.env.SKYLIGHT_EMAIL = "dad@example.com";
    process.env.SKYLIGHT_PASSWORD = "right";
    process.env.SKYLIGHT_FRAME_ID = "2245268";
    delete process.env.SKYLIGHT_TOKEN;

    const auth = fakeSkylight("right");
    let apiCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (!url.pathname.startsWith("/api/")) return auth(input, init);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ method: init?.method ?? "GET", url, headers, body: "" });
        apiCalls++;
        // First API call: pretend the token expired
        if (apiCalls === 1) return res(401, JSON.stringify({ errors: ["Invalid token"] }));
        return res(200, JSON.stringify({ data: [] }));
      })
    );

    const { SkylightClient } = await import("../src/api/client.js");
    const client = new SkylightClient();
    await client.get("/api/frames/{frameId}/chores");

    const api = calls.filter((c) => c.url.pathname.startsWith("/api/"));
    expect(api).toHaveLength(2);
    expect(api[0].headers.Authorization).toBe("Bearer access-1");
    expect(api[1].headers.Authorization).toBe("Bearer access-2"); // refreshed, not a full re-login
    expect(api[1].headers["skylight-api-version"]).toBe("2026-03-01");
    expect(api[1].url.pathname).toBe("/api/frames/2245268/chores");

    delete process.env.SKYLIGHT_EMAIL;
    delete process.env.SKYLIGHT_PASSWORD;
  });

  it("treats an empty response body (e.g. a delete) as success", async () => {
    vi.resetModules();
    process.env.SKYLIGHT_TOKEN = "t";
    process.env.SKYLIGHT_FRAME_ID = "2245268";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const { SkylightClient } = await import("../src/api/client.js");
    await expect(new SkylightClient().request("/api/frames/{frameId}/chores/1", { method: "DELETE" })).resolves.toEqual({});
  });
});
