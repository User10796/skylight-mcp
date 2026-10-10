/**
 * Skylight Authentication
 *
 * Skylight retired the old JSON login (POST /api/sessions now answers
 * "This version of Skylight is no longer supported"). Current clients log in
 * through a Rails form + OAuth code flow, the same one the mobile app uses:
 *
 *   1. GET  /auth/session/new   -> CSRF authenticity_token + session cookie
 *   2. POST /auth/session       -> form login (302 = success, 200 = bad creds)
 *   3. GET  /oauth/authorize    -> 302 with ?code=...
 *   4. POST /oauth/token        -> access_token (+ refresh_token)
 *
 * API calls then use `Authorization: Bearer <access_token>` plus a
 * `skylight-api-version` header.
 */

import { createHash, randomBytes } from "node:crypto";

const BASE_URL = "https://app.ourskylight.com";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const CLIENT_ID = "skylight-mobile";
const SCOPE = "everything";
const REDIRECT_URI = "https://ourskylight.com/welcome";

export interface AuthResult {
  email: string;
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until the access token expires, if the server says */
  expiresIn: number | null;
}

/**
 * Stable per-account device fingerprint (UUID-shaped). Skylight ties refresh
 * tokens to it, so it must not change between restarts. Derived from the email
 * unless SKYLIGHT_DEVICE_FINGERPRINT is set.
 */
export function deviceFingerprint(email: string): string {
  const override = process.env.SKYLIGHT_DEVICE_FINGERPRINT;
  if (override) return override;
  const hex = createHash("sha256").update(`skylight-mcp:${email.toLowerCase()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Minimal cookie jar so the Rails session survives across the login steps. */
class CookieJar {
  private cookies = new Map<string, string>();

  store(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : splitSetCookie(response.headers.get("set-cookie"));
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function splitSetCookie(value: string | null): string[] {
  // Fallback for runtimes without Headers.getSetCookie(): split on commas that
  // start a new "name=" pair (Expires dates also contain commas).
  return value ? value.split(/,(?=\s*[^;,\s]+=)/) : [];
}

async function step(
  jar: CookieJar,
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {}
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: BROWSER_ACCEPT,
      Cookie: jar.header(),
      ...(init.headers ?? {}),
    },
  });
  jar.store(response);
  return response;
}

function extractCsrfToken(html: string): string | null {
  const input = html.match(/name="authenticity_token"[^>]*value="([^"]+)"/) ??
    html.match(/value="([^"]+)"[^>]*name="authenticity_token"/);
  if (input) return decodeEntities(input[1]);
  const meta = html.match(/<meta[^>]*name="csrf-token"[^>]*content="([^"]+)"/);
  return meta ? decodeEntities(meta[1]) : null;
}

/** Pull a readable message out of an OAuth error page or JSON body. */
function describeErrorPage(body: string): string {
  try {
    const json = JSON.parse(body);
    return [json.error, json.error_description].filter(Boolean).join(": ") || body.slice(0, 300);
  } catch {
    // HTML error page: prefer the error description paragraph, else visible text
  }
  const desc = body.match(/<(?:pre|p)[^>]*>([\s\S]*?)<\/(?:pre|p)>/i);
  const text = (desc ? desc[1] : body)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeEntities(text).slice(0, 300) || "(empty response)";
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x2B;|&#43;/gi, "+")
    .replace(/&#x2F;|&#47;/gi, "/")
    .replace(/&#x3D;|&#61;/gi, "=")
    .replace(/&amp;/g, "&");
}

/**
 * Log in with email/password and obtain an OAuth access token.
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  console.error(`[auth] Logging in as ${email}...`);
  const jar = new CookieJar();
  const fingerprint = deviceFingerprint(email);

  // 1. Login page -> CSRF token
  const page = await step(jar, `${BASE_URL}/auth/session/new`);
  if (page.status !== 200) {
    throw new Error(`Login failed: could not load Skylight login page (HTTP ${page.status}).`);
  }
  const csrf = extractCsrfToken(await page.text());
  if (!csrf) {
    throw new Error("Login failed: Skylight's login page has changed (no CSRF token found).");
  }

  // 2. Submit the login form
  const form = await step(jar, `${BASE_URL}/auth/session`, {
    method: "POST",
    body: new URLSearchParams({ authenticity_token: csrf, email, password }).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/auth/session/new`,
    },
  });
  if (form.status === 200) {
    throw new Error(
      "Invalid email or password. Please check your SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD environment variables."
    );
  }
  if (form.status !== 302 && form.status !== 303) {
    throw new Error(`Login failed: unexpected HTTP ${form.status} from Skylight's login form.`);
  }
  // Rejected credentials redirect straight back to the sign-in page
  if ((form.headers.get("location") ?? "").includes("/auth/session/new")) {
    throw new Error(
      "Invalid email or password. Please check your SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD environment variables."
    );
  }

  // 3. Authorize -> code (with PKCE, which current OAuth servers may require)
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const authorizeUrl =
    `${BASE_URL}/oauth/authorize?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      skylight_api_client_device_fingerprint: fingerprint,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
  const authorize = await step(jar, authorizeUrl);
  const location = authorize.headers.get("location") ?? "";
  const code = location ? new URL(location, BASE_URL).searchParams.get("code") : null;
  if (!code) {
    if (location.includes("/auth/session")) {
      throw new Error(
        "Login did not complete: Skylight sent us back to the sign-in page. Check your credentials, " +
          "or sign in once at app.ourskylight.com in case the account needs verification."
      );
    }
    const oauthError = location ? new URL(location, BASE_URL).searchParams : null;
    const detail = oauthError?.get("error")
      ? `${oauthError.get("error")}: ${oauthError.get("error_description") ?? ""}`
      : describeErrorPage(await authorize.text());
    throw new Error(
      `Login failed: no authorization code from Skylight (HTTP ${authorize.status}). Skylight said: ${detail}`
    );
  }

  // 4. Exchange code -> token
  const token = await requestToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    skylight_api_client_device_fingerprint: fingerprint,
  });
  console.error("[auth] Login successful");
  return { email, ...token };
}

/**
 * Exchange a refresh token for a new access token.
 */
export async function refreshLogin(email: string, refreshToken: string): Promise<AuthResult> {
  const token = await requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    skylight_api_client_device_fingerprint: deviceFingerprint(email),
  });
  return { email, ...token, refreshToken: token.refreshToken ?? refreshToken };
}

async function requestToken(
  params: Record<string, string>
): Promise<Omit<AuthResult, "email">> {
  const response = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Login failed: token exchange returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  let payload: { access_token?: string; refresh_token?: string; expires_in?: number | string };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Login failed: Skylight's token response was not JSON.");
  }
  if (!payload.access_token) {
    throw new Error("Login failed: Skylight's token response had no access token.");
  }
  const expires = payload.expires_in == null ? null : Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: Number.isFinite(expires) ? expires : null,
  };
}
