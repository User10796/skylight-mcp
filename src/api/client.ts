import { getConfig, usesEmailAuth, type Config } from "../config.js";
import { login, refreshLogin, type AuthResult } from "./auth.js";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  SkylightError,
} from "../utils/errors.js";

const BASE_URL = "https://app.ourskylight.com";

/** API version header current Skylight clients send (override with SKYLIGHT_API_VERSION). */
const DEFAULT_API_VERSION = "2026-03-01";

/**
 * Skylight subscription status types
 */
export type SubscriptionStatus = "plus" | "free" | "trial" | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | boolean | number | undefined>;
  body?: unknown;
}

/**
 * Skylight API Client
 * Handles authentication and HTTP requests to the Skylight API
 */
export class SkylightClient {
  private config: Config;
  private session: AuthResult | null = null;
  private loginPromise: Promise<AuthResult> | null = null;
  private subscriptionStatus: SubscriptionStatus = null;

  constructor(config?: Config) {
    this.config = config ?? getConfig();
  }

  /**
   * Log in (email/password auth) once, sharing a single in-flight login.
   */
  private async ensureSession(): Promise<AuthResult> {
    if (this.session) return this.session;
    if (!this.loginPromise) {
      const { email, password } = this.config;
      if (!email || !password) {
        throw new AuthenticationError("Email and password are required for login");
      }
      this.loginPromise = login(email, password);
    }
    try {
      this.session = await this.loginPromise;
      return this.session;
    } finally {
      this.loginPromise = null;
    }
  }

  /**
   * After a 401: try the refresh token, then fall back to a full login.
   */
  private async renewSession(): Promise<void> {
    const previous = this.session;
    this.session = null;
    const email = this.config.email!;
    if (previous?.refreshToken) {
      try {
        this.session = await refreshLogin(email, previous.refreshToken);
        console.error("[client] Refreshed access token");
        return;
      } catch (error) {
        console.error(`[client] Token refresh failed, logging in again: ${(error as Error).message}`);
      }
    }
    await this.ensureSession();
  }

  /**
   * Build the Authorization header.
   * Email/password auth: OAuth Bearer token. Manual token: per SKYLIGHT_AUTH_TYPE.
   */
  private async getAuthHeader(): Promise<string> {
    if (usesEmailAuth(this.config)) {
      const session = await this.ensureSession();
      return `Bearer ${session.accessToken}`;
    }
    const token = this.config.token!;
    return this.config.authType === "basic" ? `Basic ${token}` : `Bearer ${token}`;
  }

  /**
   * Build URL with query parameters
   */
  private buildUrl(endpoint: string, params?: Record<string, string | boolean | number | undefined>): string {
    const url = new URL(endpoint, BASE_URL);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  /**
   * Handle API response errors
   */
  private async handleResponseError(response: Response, url: string): Promise<never> {
    const status = response.status;

    if (status === 401) {
      // Clear cached credentials on auth failure
      this.session = null;
      console.error(`[client] 401 Unauthorized for ${url}`);

      if (usesEmailAuth(this.config)) {
        throw new AuthenticationError(
          "API request returned 401. This may indicate your frame ID is incorrect or doesn't belong to this account. " +
            "Please verify your SKYLIGHT_FRAME_ID environment variable."
        );
      }
      throw new AuthenticationError();
    }

    if (status === 404) {
      throw new NotFoundError("Resource");
    }

    if (status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
    }

    // Try to get error details from response
    let errorMessage = `HTTP ${status}`;
    try {
      const errorBody = await response.text();
      if (errorBody) {
        errorMessage += `: ${errorBody.slice(0, 200)}`;
      }
    } catch {
      // Ignore parse errors
    }

    throw new SkylightError(errorMessage, "HTTP_ERROR", status, status >= 500);
  }

  /**
   * Make an authenticated request to the Skylight API
   */
  async request<T>(endpoint: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
    const { method = "GET", params, body } = options;

    // Replace {frameId} placeholder with actual frame ID
    const resolvedEndpoint = endpoint.replace("{frameId}", this.config.frameId);
    const url = this.buildUrl(resolvedEndpoint, params);

    console.error(`[client] ${method} ${url}`);

    const headers: Record<string, string> = {
      Authorization: await this.getAuthHeader(),
      Accept: "application/json",
      "skylight-api-version": process.env.SKYLIGHT_API_VERSION || DEFAULT_API_VERSION,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    console.error(`[client] Response: ${response.status}`);

    if (!response.ok) {
      // For email/password auth, try re-login once on 401
      if (response.status === 401 && usesEmailAuth(this.config) && !isRetry) {
        console.error("[client] Got 401, renewing session...");
        await this.renewSession();
        return this.request<T>(endpoint, options, true);
      }
      await this.handleResponseError(response, url);
    }

    // Handle 304 Not Modified
    if (response.status === 304) {
      return {} as T;
    }

    // Some endpoints (notably deletes) return an empty body
    const text = await response.text();
    if (!text.trim()) {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /**
   * GET request helper
   */
  async get<T>(endpoint: string, params?: Record<string, string | boolean | number | undefined>): Promise<T> {
    return this.request<T>(endpoint, { method: "GET", params });
  }

  /**
   * POST request helper
   */
  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: "POST", body });
  }

  /**
   * Get the frame ID from config
   */
  get frameId(): string {
    return this.config.frameId;
  }

  /**
   * Get the timezone from config
   */
  get timezone(): string {
    return this.config.timezone;
  }

  /**
   * Check if user has Plus subscription
   */
  hasPlus(): boolean {
    return this.subscriptionStatus === "plus";
  }

  /**
   * Get the subscription status
   */
  getSubscriptionStatus(): SubscriptionStatus {
    return this.subscriptionStatus;
  }

  /**
   * Initialize the client (triggers login if using email/password auth)
   */
  async initialize(): Promise<void> {
    if (usesEmailAuth(this.config)) {
      const session = await this.ensureSession();
      console.error(`Logged in as ${session.email}`);
    }
    this.subscriptionStatus = await this.detectSubscription();
  }

  /**
   * The new login no longer reports the subscription, so detect Plus by
   * whether a Plus-only endpoint answers. SKYLIGHT_PLUS=true|false overrides.
   */
  private async detectSubscription(): Promise<SubscriptionStatus> {
    const override = process.env.SKYLIGHT_PLUS?.toLowerCase();
    if (override === "true" || override === "1") return "plus";
    if (override === "false" || override === "0") return "free";
    try {
      await this.get("/api/frames/{frameId}/rewards");
      return "plus";
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      return "free";
    }
  }
}

// Singleton instance
let clientInstance: SkylightClient | null = null;

export function getClient(): SkylightClient {
  if (!clientInstance) {
    clientInstance = new SkylightClient();
  }
  return clientInstance;
}

/**
 * Initialize the client singleton and return it
 * This triggers login if using email/password auth
 */
export async function initializeClient(): Promise<SkylightClient> {
  const client = getClient();
  await client.initialize();
  return client;
}
