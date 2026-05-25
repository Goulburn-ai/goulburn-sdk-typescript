#!/usr/bin/env node
/**
 * goulburn CLI entry point.
 *
 * Mirrors the Python SDK's command surface:
 *   goulburn auth verify
 *   goulburn agents list
 *   goulburn agents get <name>
 *   goulburn probe run <name> --kind <compliance|capability>
 *   goulburn trust query <name> [--json]
 */
import { Command } from "commander";

import { Client } from "./client.js";
import {
  APIError,
  AuthenticationError,
  GoulburnError,
  RateLimitError,
} from "./errors.js";
import { version as SDK_VERSION } from "./version.js";

interface RootContext {
  apiKey?: string;
  baseUrl?: string;
}

function exitFor(err: unknown): never {
  if (err instanceof RateLimitError) {
    const after = err.retryAfterSeconds !== null ? ` (retry after ${err.retryAfterSeconds}s)` : "";
    console.error(`Rate limited: ${err.detail}${after}`);
    process.exit(5);
  }
  if (err instanceof AuthenticationError) {
    console.error(`Auth failed: ${err.detail}`);
    process.exit(2);
  }
  if (err instanceof APIError) {
    console.error(`API error (${err.statusCode}): ${err.detail}`);
    process.exit(3);
  }
  if (err instanceof GoulburnError) {
    console.error(`Error: ${err.message}`);
    process.exit(4);
  }
  console.error(`Unexpected error: ${String(err)}`);
  process.exit(1);
}

function makeClient(ctx: RootContext): Client {
  return new Client({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name("goulburn")
    .description("goulburn CLI — manage your fleet from the terminal.")
    .version(SDK_VERSION, "-v, --version")
    .option("--api-key <key>", "Owner API key. Defaults to $GOULBURN_API_KEY.")
    .option("--base-url <url>", "API base URL. Defaults to $GOULBURN_API_BASE.");

  // ── auth ─────────────────────────────────────────────────────
  const auth = program.command("auth").description("Authentication helpers.");
  auth
    .command("verify")
    .description("Confirm the API key works and show your identity.")
    .action(async () => {
      try {
        const client = makeClient(program.opts());
        const me = await client.auth.verify();
        console.log(`Signed in as: ${me.email}`);
        if (me.display_name) console.log(`Display name: ${me.display_name}`);
        console.log(`Owner ID:     ${me.owner_id}`);
      } catch (err) {
        exitFor(err);
      }
    });

  // ── agents ───────────────────────────────────────────────────
  const agents = program.command("agents").description("Manage your agents.");
  agents
    .command("list")
    .description("List agents owned by the authenticated owner.")
    .action(async () => {
      try {
        const client = makeClient(program.opts());
        const result = await client.agents.list();
        if (!result.data.length) {
          console.log("No agents found. Register one at https://goulburn.ai/agents/register");
          return;
        }
        console.log(`${result.data.length} agent(s):`);
        for (const a of result.data) {
          let desc = (a.description ?? "").replace(/\n/g, " ");
          if (desc.length > 60) desc = `${desc.slice(0, 57)}...`;
          console.log(`  - ${a.name}  ${desc}`);
        }
      } catch (err) {
        exitFor(err);
      }
    });
  agents
    .command("get <name>")
    .description("Show details for one agent.")
    .action(async (name: string) => {
      try {
        const client = makeClient(program.opts());
        const agent = await client.agents.get(name);
        // Strip null/undefined for readability.
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(agent)) {
          if (v !== null && v !== undefined) out[k] = v;
        }
        console.log(JSON.stringify(out, null, 2));
      } catch (err) {
        exitFor(err);
      }
    });

  // ── probe ────────────────────────────────────────────────────
  const probe = program.command("probe").description("Run probes against your agents.");
  probe
    .command("run <agent_name>")
    .description("Trigger an on-demand probe.")
    .requiredOption(
      "--kind <kind>",
      "Probe type: compliance | capability",
      (value: string) => {
        if (value !== "compliance" && value !== "capability") {
          throw new Error(`--kind must be 'compliance' or 'capability', got '${value}'`);
        }
        return value;
      },
    )
    .action(async (agentName: string, opts: { kind: "compliance" | "capability" }) => {
      try {
        const client = makeClient(program.opts());
        const result = await client.probes.run(agentName, { kind: opts.kind });
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(result)) {
          if (v !== null && v !== undefined) out[k] = v;
        }
        console.log(JSON.stringify(out, null, 2));
      } catch (err) {
        exitFor(err);
      }
    });

  // ── trust ────────────────────────────────────────────────────
  const trust = program.command("trust").description("Trust score queries.");
  trust
    .command("query <agent_name>")
    .description("Show the full trust profile for an agent.")
    .option("--json", "Output raw JSON.", false)
    .action(async (agentName: string, opts: { json: boolean }) => {
      try {
        const client = makeClient(program.opts());
        const profile = await client.trust.profile(agentName);
        if (opts.json) {
          console.log(JSON.stringify(profile, null, 2));
          return;
        }
        console.log(`Agent:         ${profile.agent}`);
        console.log(`Tier:          ${profile.tier}`);
        console.log(`Overall score: ${profile.overall_score}`);
        console.log("Layers:");
        for (const [layerName, layerData] of Object.entries(profile.layers)) {
          const score = layerData?.score ?? "—";
          console.log(`  ${layerName.padEnd(14)} ${String(score)}`);
        }
      } catch (err) {
        exitFor(err);
      }
    });

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  await buildCli().parseAsync([...argv]);
}

// Run when invoked directly (binary entry).
if (
  // Detect CLI invocation cleanly under both ESM and node-loader contexts.
  // Use import.meta.url if available; fall back to checking argv[1].
  typeof import.meta !== "undefined" &&
  import.meta.url &&
  process.argv[1] &&
  new URL(import.meta.url).pathname === process.argv[1]
) {
  void main();
}
