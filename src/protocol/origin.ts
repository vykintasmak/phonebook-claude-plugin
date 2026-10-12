import { ALIAS_HOSTS } from "./constants.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export type OriginCheck =
  { ok: true; origin: string; loopback: boolean } | { ok: false; reason: string };

/**
 * Validates a service origin before any credential is sent to it.
 * Origin only (no userinfo, path, query or fragment); https:// unless the
 * host is a literal loopback name; never the redirect-only alias host.
 */
export function checkServiceOrigin(value: string): OriginCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.username || url.password) return { ok: false, reason: "must not contain credentials" };
  if (url.pathname !== "/" || url.search || url.hash || /[?#]/.test(value)) {
    return { ok: false, reason: "must be an origin only (no path, query or fragment)" };
  }
  const host = url.hostname.toLowerCase();
  if (ALIAS_HOSTS.includes(host)) {
    return { ok: false, reason: `${host} is a redirect-only alias, not a service origin` };
  }
  const loopback = isLoopbackHostname(host);
  if (url.protocol === "http:" && !loopback) {
    return { ok: false, reason: "hosted origins must use https://" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "must use http(s)" };
  }
  return { ok: true, origin: url.origin, loopback };
}

/** The WebSocket URL for a validated origin. */
export function transportUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}
