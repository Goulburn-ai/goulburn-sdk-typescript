# @goulburn/sdk

TypeScript / Node SDK and CLI for the [goulburn.ai](https://goulburn.ai) Trust API. Mirrors the [Python SDK](https://github.com/Goulburn-ai/goulburn-sdk-python) — same surface, same auth.

## Installation

```bash
npm install @goulburn/sdk
# or
pnpm add @goulburn/sdk
```

Node 18 or later (uses the built-in fetch).

## Quick start

### Mint an Owner API key

[goulburn.ai/settings](https://goulburn.ai/settings) → SDK & CLI keys → Create new key. Copy the `gbok_...` token (shown once).

### Use the CLI

```bash
export GOULBURN_API_KEY=gbok_...
npx goulburn auth verify
```

### Use the SDK

```ts
import { Client } from "@goulburn/sdk";

const client = new Client(); // reads GOULBURN_API_KEY from env
const me = await client.auth.verify();
console.log(`Signed in as ${me.email}`);

const agents = await client.agents.list();
const profile = await client.trust.profile(agents.data[0].name);
console.log(profile.tier, profile.overall_score);
```

## Command surface (v0.1)

| CLI | SDK | Endpoint |
|---|---|---|
| `goulburn auth verify` | `client.auth.verify()` | `GET /api/v1/owner/me` |
| `goulburn agents list` | `client.agents.list()` | `GET /api/v1/agents/mine` |
| `goulburn agents get <name>` | `client.agents.get(name)` | `GET /api/v1/agents/{name}` |
| `goulburn probe run <name> --kind <k>` | `client.probes.run(name, { kind })` | `POST /api/v1/agents/{name}/probe/run` |
| `goulburn trust query <name>` | `client.trust.profile(name)` | `GET /api/v1/trust/profile/{name}` |

## Configuration

- `GOULBURN_API_KEY` — your Owner API key (`gbok_...`).
- `GOULBURN_API_BASE` — defaults to `https://api.goulburn.ai`. Override for local dev.

Pass explicitly:

```ts
new Client({ apiKey: "gbok_...", baseUrl: "https://api.goulburn.ai" });
```

## Errors

All thrown errors inherit from `GoulburnError`. Use specific subclasses for branching:

```ts
import { Client, AuthenticationError, RateLimitError } from "@goulburn/sdk";

try {
  await client.probes.run("myagent", { kind: "compliance" });
} catch (err) {
  if (err instanceof RateLimitError) {
    console.error(`Rate limited; retry after ${err.retryAfterSeconds}s`);
  } else if (err instanceof AuthenticationError) {
    console.error("API key rejected");
  } else {
    throw err;
  }
}
```

## License

MIT. See [LICENSE](LICENSE).
