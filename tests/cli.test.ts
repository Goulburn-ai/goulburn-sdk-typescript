import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "../src/index.js";
import { buildCli } from "../src/cli.js";

interface FakeResp { status?: number; body?: unknown; headers?: Record<string, string> }

function makeResp(init: FakeResp = {}): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? { "Content-Type": "application/json" });
  const body = init.body === undefined ? "" : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return new Response(body || null, { status, headers });
}

function fakeFetch(responses: FakeResp[]): (...a: Parameters<typeof fetch>) => Promise<Response> {
  let idx = 0;
  return () => Promise.resolve(makeResp(responses[idx++] ?? { status: 500 }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let logSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let errSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: any;

beforeEach(() => {
  process.env.GOULBURN_API_KEY = "gbok_test";
  process.env.GOULBURN_API_BASE = "https://api.example.com";
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  delete process.env.GOULBURN_API_KEY;
  delete process.env.GOULBURN_API_BASE;
});

/** Run the CLI with an injected Client whose fetch is faked. */
async function runCli(args: string[], fetcher: ReturnType<typeof fakeFetch>): Promise<void> {
  // Patch the Client prototype so its fetch is captured.
  const origRequest = Client.prototype["_request" as keyof Client] as unknown as (...a: unknown[]) => unknown;
  const tempClientCtor = Client;
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;
  try {
    const cli = buildCli();
    await cli.parseAsync(["node", "goulburn", ...args]);
  } finally {
    globalThis.fetch = origFetch;
    void origRequest;
    void tempClientCtor;
  }
}

describe("CLI: auth verify", () => {
  it("prints identity on success", async () => {
    await runCli(["auth", "verify"], fakeFetch([{ body: { owner_id: "abc", email: "test@example.com", display_name: "Test" } }]));
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("test@example.com");
    expect(out).toContain("abc");
  });

  it("exits 2 on auth failure", async () => {
    await runCli(["auth", "verify"], fakeFetch([{ status: 401, body: { detail: "no" } }]));
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

describe("CLI: agents list", () => {
  it("renders names", async () => {
    await runCli(
      ["agents", "list"],
      fakeFetch([{ body: { data: [{ name: "alpha" }, { name: "beta" }], has_more: false } }]),
    );
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("2 agent(s)");
  });

  it("renders empty-state message", async () => {
    await runCli(["agents", "list"], fakeFetch([{ body: { data: [], has_more: false } }]));
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("No agents found");
  });
});

describe("CLI: trust query", () => {
  it("renders human-friendly summary by default", async () => {
    await runCli(
      ["trust", "query", "y"],
      fakeFetch([{ body: { agent: "y", tier: "verified", overall_score: 60, layers: { identity: { score: 80 } } } }]),
    );
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("verified");
    expect(out).toContain("60");
    expect(out).toContain("identity");
  });

  it("--json prints raw JSON", async () => {
    await runCli(
      ["trust", "query", "y", "--json"],
      fakeFetch([{ body: { agent: "y", tier: "v", overall_score: 1, layers: {} } }]),
    );
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain('"agent"');
    expect(out).toContain('"layers"');
  });
});

describe("CLI: probe run", () => {
  it("posts kind compliance", async () => {
    await runCli(
      ["probe", "run", "x", "--kind", "compliance"],
      fakeFetch([{ body: { probe_id: "p1" } }]),
    );
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toContain("probe_id");
  });
});
