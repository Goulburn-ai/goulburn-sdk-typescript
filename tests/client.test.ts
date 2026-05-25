import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APIError,
  AuthenticationError,
  Client,
  NotFoundError,
  RateLimitError,
} from "../src/index.js";

// ── Fake fetch helper ───────────────────────────────────────────

interface FakeResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? { "Content-Type": "application/json" });
  const bodyStr = init.body === undefined ? "" : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return new Response(bodyStr || null, { status, headers });
}

type FakeFetch = ((...args: Parameters<typeof fetch>) => Promise<Response>) & {
  calls: Array<{ url: string; init?: RequestInit }>;
  responses: FakeResponseInit[];
  responseFactory?: () => FakeResponseInit;
};

function fakeFetch(responses: FakeResponseInit[] = []): FakeFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let idx = 0;
  const impl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (impl.responseFactory) return Promise.resolve(makeResponse(impl.responseFactory()));
    const r = impl.responses[idx];
    idx += 1;
    if (!r) throw new Error(`fakeFetch: no response queued for call #${idx}`);
    return Promise.resolve(makeResponse(r));
  }) as FakeFetch;
  impl.calls = calls;
  impl.responses = responses;
  return impl;
}

const OWNER = { owner_id: "abc", email: "test@example.com", display_name: "Test" };
const BASE = "https://api.example.com";

beforeEach(() => {
  process.env.GOULBURN_API_KEY = "gbok_test";
});

afterEach(() => {
  delete process.env.GOULBURN_API_KEY;
  delete process.env.GOULBURN_API_BASE;
});

describe("auth.verify", () => {
  it("returns the owner identity on 200", async () => {
    const fetcher = fakeFetch([{ body: OWNER }]);
    const client = new Client({ baseUrl: BASE, fetchImpl: fetcher });
    const me = await client.auth.verify();
    expect(me.email).toBe("test@example.com");
    expect(fetcher.calls[0].url).toBe(`${BASE}/api/v1/owner/me`);
    const auth = (fetcher.calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer gbok_test");
  });

  it("raises AuthenticationError on 401", async () => {
    const client = new Client({
      baseUrl: BASE,
      fetchImpl: fakeFetch([{ status: 401, body: { detail: "Invalid key" } }]),
    });
    await expect(client.auth.verify()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("raises NotFoundError on 404", async () => {
    const client = new Client({
      baseUrl: BASE,
      fetchImpl: fakeFetch([{ status: 404, body: { detail: "nope" } }]),
    });
    await expect(client.auth.verify()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("raises RateLimitError on 429 with retry-after", async () => {
    const client = new Client({
      baseUrl: BASE,
      maxRetries: 0,
      fetchImpl: fakeFetch([{ status: 429, body: { detail: "slow" }, headers: { "retry-after": "30", "Content-Type": "application/json" } }]),
    });
    try {
      await client.auth.verify();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterSeconds).toBe(30);
    }
  });

  it("retries on 503 then succeeds", async () => {
    const client = new Client({
      baseUrl: BASE,
      maxRetries: 3,
      fetchImpl: fakeFetch([
        { status: 503, body: { detail: "warming" } },
        { body: OWNER },
      ]),
    });
    const me = await client.auth.verify();
    expect(me.email).toBe("test@example.com");
  });

  it("does NOT retry on 400", async () => {
    const fetcher = fakeFetch([{ status: 400, body: { detail: "bad" } }]);
    const client = new Client({ baseUrl: BASE, maxRetries: 5, fetchImpl: fetcher });
    await expect(client.auth.verify()).rejects.toBeInstanceOf(APIError);
    expect(fetcher.calls.length).toBe(1);
  });
});

describe("agents", () => {
  it("list returns AgentList", async () => {
    const client = new Client({
      baseUrl: BASE,
      fetchImpl: fakeFetch([
        { body: { data: [{ name: "alpha", description: "first" }, { name: "beta" }], has_more: false } },
      ]),
    });
    const result = await client.agents.list();
    expect(result.data.length).toBe(2);
    expect(result.data[0].name).toBe("alpha");
  });

  it("get returns a single Agent", async () => {
    const fetcher = fakeFetch([{ body: { name: "myagent", description: "x", status: "active" } }]);
    const client = new Client({ baseUrl: BASE, fetchImpl: fetcher });
    const agent = await client.agents.get("myagent");
    expect(agent.name).toBe("myagent");
    expect(fetcher.calls[0].url).toBe(`${BASE}/api/v1/agents/myagent`);
  });

  it("get encodes the agent name", async () => {
    const fetcher = fakeFetch([{ body: { name: "weird/name" } }]);
    const client = new Client({ baseUrl: BASE, fetchImpl: fetcher });
    await client.agents.get("weird/name");
    // Slash must be encoded so it doesn't become a path segment.
    expect(fetcher.calls[0].url).toContain("/agents/weird%2Fname");
  });
});

describe("probes.run", () => {
  it("posts with kind=compliance", async () => {
    const fetcher = fakeFetch([{ body: { probe_id: "p1" } }]);
    const client = new Client({ baseUrl: BASE, fetchImpl: fetcher });
    const result = await client.probes.run("myagent", { kind: "compliance" });
    expect(fetcher.calls[0].init?.method).toBe("POST");
    expect(fetcher.calls[0].url).toContain("kind=compliance");
    expect(result.probe_id).toBe("p1");
  });

  it("rejects invalid kind locally", async () => {
    const client = new Client({ baseUrl: BASE, fetchImpl: fakeFetch() });
    await expect(
      // @ts-expect-error — intentional bad type at runtime
      client.probes.run("myagent", { kind: "bogus" }),
    ).rejects.toThrow(/kind must be/);
  });
});

describe("trust.profile", () => {
  it("returns TrustProfile with layers", async () => {
    const payload = {
      agent: "y",
      tier: "verified",
      overall_score: 67,
      layers: { identity: { score: 80 }, compliance: { score: 70 } },
    };
    const client = new Client({
      baseUrl: BASE,
      fetchImpl: fakeFetch([{ body: payload }]),
    });
    const profile = await client.trust.profile("y");
    expect(profile.agent).toBe("y");
    expect(profile.overall_score).toBe(67);
    expect(profile.layers.identity.score).toBe(80);
  });
});

describe("config resolution", () => {
  it("explicit apiKey beats env", async () => {
    process.env.GOULBURN_API_KEY = "gbok_env";
    const fetcher = fakeFetch([{ body: OWNER }]);
    const client = new Client({ baseUrl: BASE, apiKey: "gbok_explicit", fetchImpl: fetcher });
    await client.auth.verify();
    const auth = (fetcher.calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer gbok_explicit");
  });

  it("env apiKey is used when no explicit", async () => {
    process.env.GOULBURN_API_KEY = "gbok_env";
    const fetcher = fakeFetch([{ body: OWNER }]);
    const client = new Client({ baseUrl: BASE, fetchImpl: fetcher });
    await client.auth.verify();
    const auth = (fetcher.calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer gbok_env");
  });

  it("missing apiKey throws AuthenticationError", () => {
    delete process.env.GOULBURN_API_KEY;
    expect(() => new Client({ baseUrl: BASE })).toThrow(AuthenticationError);
  });

  it("baseUrl default is api.goulburn.ai", async () => {
    // Provide a stub fetch so the Client never actually goes anywhere.
    const fetcher = fakeFetch([{ body: OWNER }]);
    const client = new Client({ fetchImpl: fetcher });
    await client.auth.verify();
    expect(fetcher.calls[0].url).toBe("https://api.goulburn.ai/api/v1/owner/me");
  });

  it("baseUrl env override works", async () => {
    process.env.GOULBURN_API_BASE = "https://api.staging.goulburn.ai";
    const fetcher = fakeFetch([{ body: OWNER }]);
    const client = new Client({ fetchImpl: fetcher });
    await client.auth.verify();
    expect(fetcher.calls[0].url).toBe("https://api.staging.goulburn.ai/api/v1/owner/me");
  });
});

describe("error class identity", () => {
  it("APIError carries statusCode + detail", () => {
    const e = new APIError(500, "boom");
    expect(e.statusCode).toBe(500);
    expect(e.detail).toBe("boom");
    expect(e.message).toContain("500");
    expect(e).toBeInstanceOf(APIError);
  });

  it("subclasses inherit from APIError + GoulburnError", () => {
    const e = new AuthenticationError(401, "x");
    expect(e).toBeInstanceOf(APIError);
    expect(e.name).toBe("AuthenticationError");
  });
});
