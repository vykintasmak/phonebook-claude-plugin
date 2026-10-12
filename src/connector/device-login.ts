import { spawn } from "node:child_process";

/**
 * WorkOS first-party CLI device authorization (RFC 8628 shape).
 *
 * - Requests a device code directly from WorkOS with the PUBLIC client ID.
 * - Shows the user code (never the device code) and the verification URL.
 * - Opens the browser only for a URL on the configured trusted AuthKit origin.
 * - Polls with the provider interval; `slow_down` adds 5 s (RFC 8628 §3.5);
 *   honours denial, expiry, the overall deadline and cancellation.
 * - Returns the access token in memory only. The refresh token is discarded.
 */
export interface DeviceAuthConfig {
  clientId: string;
  authkitOrigin: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface DeviceLoginIO {
  /** Shows text to the person at the terminal (stderr in setup). */
  say: (line: string) => void;
  openBrowser: (url: string) => Promise<boolean>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetch: typeof fetch;
  now: () => number;
}

export class DeviceLoginError extends Error {
  constructor(
    readonly code:
      "denied" | "expired" | "cancelled" | "provider_error" | "untrusted_url" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

const MAX_TRANSIENT_FAILURES = 5;

export function defaultOpenBrowser(url: string): Promise<boolean> {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? null : "xdg-open";
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      // Argument array, no shell: the URL is never interpreted by a shell.
      const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DeviceLoginError("cancelled", "Sign-in cancelled."));
      },
      { once: true },
    );
  });

export function isTrustedVerificationUrl(url: string, authkitOrigin: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.origin === new URL(authkitOrigin).origin;
  } catch {
    return false;
  }
}

async function postForm(
  io: DeviceLoginIO,
  url: string,
  body: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await io.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON
  }
  return { status: res.status, json };
}

export async function deviceLogin(
  cfg: DeviceAuthConfig,
  io: DeviceLoginIO,
  opts: { noBrowser?: boolean; signal?: AbortSignal } = {},
): Promise<{ accessToken: string }> {
  const start = await startDeviceLogin(cfg, io, opts);
  return pollDeviceLogin(cfg, io, start, opts.signal ? { signal: opts.signal } : {});
}

/** A started device authorization: what polling needs (deviceCode is short-lived and private). */
export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  /** In io.now() time. */
  expiresAt: number;
}

/**
 * Starts WorkOS device authorization: validates the sign-in domain, shows the confirmation
 * code and opens the browser. Returns immediately so the code can be seen before waiting.
 */
export async function startDeviceLogin(
  cfg: DeviceAuthConfig,
  io: DeviceLoginIO,
  opts: { noBrowser?: boolean } = {},
): Promise<DeviceStart> {
  const start = await postForm(io, cfg.deviceAuthorizationEndpoint, {
    client_id: cfg.clientId,
  }).catch(() => null);
  const s = start?.json ?? {};
  const deviceCode = typeof s.device_code === "string" ? s.device_code : null;
  const userCode = typeof s.user_code === "string" ? s.user_code : null;
  const verificationUri = typeof s.verification_uri === "string" ? s.verification_uri : null;
  const complete =
    typeof s.verification_uri_complete === "string" ? s.verification_uri_complete : null;
  if (!start || start.status !== 200 || !deviceCode || !userCode || !verificationUri) {
    throw new DeviceLoginError(
      "provider_error",
      "Could not start sign-in with the identity provider; try again.",
    );
  }
  if (
    !isTrustedVerificationUrl(verificationUri, cfg.authkitOrigin) ||
    (complete && !isTrustedVerificationUrl(complete, cfg.authkitOrigin))
  ) {
    throw new DeviceLoginError(
      "untrusted_url",
      "The sign-in page is not on the expected Phonebook sign-in domain; stopping.",
    );
  }
  const expiresIn = typeof s.expires_in === "number" && s.expires_in > 0 ? s.expires_in : 300;
  const intervalMs = Math.max(1, typeof s.interval === "number" ? s.interval : 5) * 1000;
  const expiresAt = io.now() + expiresIn * 1000;

  io.say("");
  io.say(
    "Sign in to Phonebook with email. Signing in does not connect GitHub or grant access to your repositories.",
  );
  io.say(`  Confirmation code: ${userCode}`);
  const opened = !opts.noBrowser && (await io.openBrowser(complete ?? verificationUri));
  io.say(
    opened
      ? `  A browser window opened. If not, visit: ${verificationUri}`
      : `  Open this page in a browser: ${verificationUri}`,
  );
  io.say("  Check that the page shows the same code, then sign in with your email.");
  io.say("");
  return { deviceCode, userCode, verificationUri, intervalMs, expiresAt };
}

/** Polls the token endpoint until the browser sign-in completes, is declined, or expires. */
export async function pollDeviceLogin(
  cfg: DeviceAuthConfig,
  io: DeviceLoginIO,
  start: DeviceStart,
  opts: { signal?: AbortSignal } = {},
): Promise<{ accessToken: string }> {
  const { deviceCode } = start;
  let interval = start.intervalMs;
  const deadline = start.expiresAt;
  let transient = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new DeviceLoginError("cancelled", "Sign-in cancelled.");
    if (io.now() >= deadline)
      throw new DeviceLoginError("expired", "The sign-in code expired; run the command again.");
    await io.sleep(Math.min(interval, Math.max(0, deadline - io.now())), opts.signal);
    let r: { status: number; json: Record<string, unknown> };
    try {
      r = await postForm(io, cfg.tokenEndpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: cfg.clientId,
      });
    } catch {
      if (++transient > MAX_TRANSIENT_FAILURES)
        throw new DeviceLoginError(
          "provider_error",
          "Lost contact with the identity provider; try again.",
        );
      interval = Math.min(interval * 2, 30_000);
      continue;
    }
    if (r.status === 200 && typeof r.json.access_token === "string") {
      // Refresh token and user JSON are deliberately ignored (not trusted, not stored).
      return { accessToken: r.json.access_token };
    }
    const error = typeof r.json.error === "string" ? r.json.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5_000;
      continue;
    }
    if (error === "access_denied")
      throw new DeviceLoginError("denied", "Sign-in was declined in the browser.");
    if (error === "expired_token")
      throw new DeviceLoginError("expired", "The sign-in code expired; run the command again.");
    if (r.status >= 500 && ++transient <= MAX_TRANSIENT_FAILURES) {
      interval = Math.min(interval * 2, 30_000);
      continue;
    }
    throw new DeviceLoginError(
      "provider_error",
      "The identity provider rejected the sign-in; try again.",
    );
  }
}
