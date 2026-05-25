/**
 * Client for the goulburn.ai Trust API.
 *
 * Auth via gbok_ Owner API key as `Authorization: Bearer gbok_<key>`.
 * Reads GOULBURN_API_KEY from env unless passed explicitly.
 *
 * Retry: 408/425/429/500-504 are retried up to `maxRetries` times with
 * exponential backoff + jitter; 4xx-other surfaces immediately.
 */

import { version as SDK_VERSION } from "./version.js";
import {
  APIError,
  AuthenticationError,
  GoulburnError,
  NotFoundError,
  RateLimitError,
} from "./errors.js";
import type {
  Agent,
  AgentList,
  Owner,
  ProbeRunResult,
  TrustProfile,
} from "./models.js";

const DEFAULT_BASE_URL = "https://api.goulburn.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Override fetch — useful for tests. */
  readonly fetchImpl?: typeof fetch;
}

function resolveApiKey(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const env = (process.env.GOULBURN_API_KEY ?? "").trim();
  if (!env) {
    throw new AuthenticationError(
      0,
      "No API key configured. Pass apiKey to the Client constructor or set GOULBURN_API_KEY. Mint a key at https://goulburn.ai/settings.",
    );
  }
  return env;
}

function resolveBaseUrl(explicit?: string): string {
  const raw = explicit ?? process.env.GOULBURN_API_BASE ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const n = Number.parseInt(headerValue.trim(), 10);
  return Number.isNaN(n) || n < 0 ? null : n;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null && retryAfter >= 0) return retryAfter * 1000;
  const base = Math.min(2 ** (attempt - 1), 30) * 1000;
  const jitter = Math.random() * (base / 4);
  return base + jitter;
}

async function mapError(resp: Response): Promise<APIError> {
  let body: unknown;
  let detail: string;
  try {
    body = await resp.json();
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      detail = String(obj.detail ?? obj.error ?? JSON.stringify(obj));
    } else {
      detail = String(body);
    }
  } catch {
    body = await resp.text().catch(() => "");
    detail = (body as string) || `HTTP ${resp.status}`;
  }

  if (resp.status === 401) return new AuthenticationError(resp.status, detail, body);
  if (resp.status === 404) return new NotFoundError(resp.status, detail, body);
  if (resp.status === 429) {
    const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
    return new RateLimitError(resp.status, detail, body, retryAfter);
  }
  return new APIError(resp.status, detail, body);
}

interface RequestOptions {
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, string | number | boolean>;
  readonly body?: unknown;
}

export class Client {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  readonly auth: AuthNamespace;
  readonly agents: AgentsNamespace;
  readonly probes: ProbesNamespace;
  readonly trust: TrustNamespace;

  constructor(options: ClientOptions = {}) {
    this.apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    // Capture fetch with the right global `this`. Without bind(globalThis) some
    // runtimes throw 'Illegal invocation'.
    this.fetchImpl = (options.fetchImpl ?? fetch).bind(globalThis);

    this.auth = new AuthNamespace(this);
    this.agents = new AgentsNamespace(this);
    this.probes = new ProbesNamespace(this);
    this.trust = new TrustNamespace(this);
  }

  /** @internal */
  async _request<T>(opts: RequestOptions): Promise<T> {
    const url = this._buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": `goulburn-sdk-typescript/${SDK_VERSION}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const init: RequestInit = {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      let resp: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        resp = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (attempt > this.maxRetries) {
          throw new APIError(0, `Network error after ${attempt - 1} retries: ${String(err)}`);
        }
        await sleep(backoffMs(attempt, null));
        continue;
      }
      clearTimeout(timer);

      if (resp.ok) {
        if (resp.status === 204) return undefined as T;
        const text = await resp.text();
        if (text.length === 0) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }

      if (RETRYABLE_STATUS.has(resp.status) && attempt <= this.maxRetries) {
        const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
        await sleep(backoffMs(attempt, retryAfter));
        continue;
      }

      throw await mapError(resp);
    }
    // Unreachable.
    throw new APIError(0, `Exhausted retries: ${String(lastError)}`);
  }

  private _buildUrl(path: string, query?: Record<string, string | number | boolean>): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.append(k, String(v));
      }
    }
    return url.toString();
  }
}

class AuthNamespace {
  constructor(private readonly c: Client) {}

  async verify(): Promise<Owner> {
    return this.c._request<Owner>({ method: "GET", path: "/api/v1/owner/me" });
  }
}

class AgentsNamespace {
  constructor(private readonly c: Client) {}

  async list(): Promise<AgentList> {
    return this.c._request<AgentList>({ method: "GET", path: "/api/v1/agents/mine" });
  }

  async get(name: string): Promise<Agent> {
    return this.c._request<Agent>({ method: "GET", path: `/api/v1/agents/${encodeURIComponent(name)}` });
  }
}

class ProbesNamespace {
  constructor(private readonly c: Client) {}

  async run(agentName: string, opts: { kind: "compliance" | "capability" }): Promise<ProbeRunResult> {
    if (opts.kind !== "compliance" && opts.kind !== "capability") {
      throw new GoulburnError(`kind must be 'compliance' or 'capability', got ${String(opts.kind)}`);
    }
    return this.c._request<ProbeRunResult>({
      method: "POST",
      path: `/api/v1/agents/${encodeURIComponent(agentName)}/probe/run`,
      query: { kind: opts.kind },
    });
  }
}

class TrustNamespace {
  constructor(private readonly c: Client) {}

  async profile(agentName: string): Promise<TrustProfile> {
    return this.c._request<TrustProfile>({
      method: "GET",
      path: `/api/v1/trust/profile/${encodeURIComponent(agentName)}`,
    });
  }
}
