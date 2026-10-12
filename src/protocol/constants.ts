/**
 * Phase 0 constants shared by the Worker and the connector.
 *
 * `CANONICAL_ORIGIN` is the *intended* hosted origin. It is not live until the
 * custom domain is separately authorized and attached (see docs/domains.md).
 */
export const SERVICE_NAME = "agent-phonebook";
export const PHASE = "phase-2-exchange";

export const CANONICAL_ORIGIN = "https://phonebook.dev";
export const CANONICAL_HOST = "phonebook.dev";
/** Short human-facing alias that redirects website visits to the canonical origin. */
export const ALIAS_HOSTS: readonly string[] = ["phonebook.sh"];
/** Exact hosted service hosts: the canonical domain and the direct workers.dev fallback. */
export const HOSTED_HOSTS: readonly string[] = [
  "phonebook.dev",
  "agent-phonebook-pilot.vykintas.workers.dev",
];

/** Every pilot operation resolves this one shared Durable Object. */
export const PILOT_OBJECT_NAME = "pilot";

export const API_PATHS = {
  health: "/api/health",
  storageHealth: "/api/health/storage",
  directory: "/api/agents",
} as const;

/** Authenticated connector WebSocket transport (Phase 1). */
export const TRANSPORT_PATH = "/ws";
