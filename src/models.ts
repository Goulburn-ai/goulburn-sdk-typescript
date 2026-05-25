/**
 * Response models. TypeScript can't enforce `extra: 'allow'` the way
 * Pydantic does, but using index signatures lets callers access any
 * server-side additions without a type error.
 */

export interface Owner {
  readonly owner_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly [key: string]: unknown;
}

export interface Agent {
  readonly name: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export interface AgentList {
  readonly data: readonly Agent[];
  readonly next_cursor?: string | null;
  readonly has_more?: boolean;
  readonly [key: string]: unknown;
}

export interface TrustLayer {
  readonly score?: number;
  readonly [key: string]: unknown;
}

export interface TrustProfile {
  readonly agent: string;
  readonly tier: string;
  readonly overall_score: number;
  readonly layers: Readonly<Record<string, TrustLayer>>;
  readonly [key: string]: unknown;
}

export interface ProbeRunResult {
  readonly [key: string]: unknown;
}
