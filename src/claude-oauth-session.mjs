import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";
import {
  CLAUDE_ACCOUNT_HOMES_DIR,
  CLAUDE_ACCOUNT_POOL_PATH,
} from "./paths.mjs";
import {
  claudeSubscriptionAccountCredentialsPath,
  readClaudeAccountPoolState,
  withClaudeAccountPoolLock,
  writeClaudeAccountPoolState,
} from "./claude-account-pool.mjs";

export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
export const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

const inFlightRefreshes = new Map();

function parseTokenExpiryMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const num = Number(value);
    if (Number.isFinite(num)) return num >= 1e12 ? num : num * 1000;
  }
  return undefined;
}

export function claudeOAuthSession(accountId, {
  filePath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  now = Date.now(),
} = {}) {
  if (discoveryDisabled()) return undefined;

  const credPath = claudeSubscriptionAccountCredentialsPath(accountId, { homesDir });
  if (!existsSync(credPath)) return undefined;

  try {
    const file = lstatSync(credPath);
    if (file.isSymbolicLink() || !file.isFile()) return undefined;
    if (!privateFileIsProtected(credPath)) return undefined;
    const raw = JSON.parse(readFileSync(credPath, "utf8"));
    const blob = raw?.claudeAiOauth || raw || {};

    const accessToken = typeof blob.accessToken === "string" ? blob.accessToken.trim() : "";
    const refreshToken = typeof blob.refreshToken === "string" ? blob.refreshToken.trim() : "";
    if (!accessToken && !refreshToken) return undefined;

    const expiresAtMs = parseTokenExpiryMs(blob.expiresAt);
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= now : false;
    const needsRefresh = Number.isFinite(expiresAtMs)
      ? expiresAtMs - EXPIRY_BUFFER_MS <= now
      : !accessToken;

    const tokenFingerprint = accessToken
      ? createHash("sha256").update(accessToken).digest("hex")
      : undefined;
    const identityFingerprint = refreshToken
      ? createHash("sha256").update(refreshToken).digest("hex")
      : undefined;

    const headers = accessToken
      ? {
          authorization: `Bearer ${accessToken}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
        }
      : {};

    return {
      accountId,
      accessToken,
      refreshToken,
      // Claude Code stores the seat's plan beside the token. Neither is a
      // credential; rotation uses them to tell a Premium seat from a Standard one.
      ...(typeof blob.subscriptionType === "string" ? { subscriptionType: blob.subscriptionType } : {}),
      ...(typeof blob.rateLimitTier === "string" ? { rateLimitTier: blob.rateLimitTier } : {}),
      expiresAtMs,
      expired,
      needsRefresh,
      tokenFingerprint,
      identityFingerprint,
      headers,
    };
  } catch {
    return undefined;
  }
}

// The token endpoint is overridable so tests never reach the real one.
function defaultTokenUrl() {
  return process.env.MODEL_ROUTER_CLAUDE_OAUTH_TOKEN_URL || OAUTH_TOKEN_URL;
}

async function markReauthRequired(accountId, { filePath, now, status }) {
  await withClaudeAccountPoolLock(async () => {
    const state = readClaudeAccountPoolState(filePath);
    const account = state.accounts[accountId];
    if (!account) return;
    account.health = {
      ...account.health,
      state: "reauth-required",
      lastError: "invalid_grant: reauthentication required",
      lastErrorAt: new Date(now).toISOString(),
      lastStatus: status,
    };
    account.subscription = {
      ...account.subscription,
      status: "invalid",
    };
    writeClaudeAccountPoolState(state, filePath);
  }, { filePath });
}

async function markRefreshed(accountId, { filePath, now }) {
  await withClaudeAccountPoolLock(async () => {
    const state = readClaudeAccountPoolState(filePath);
    const account = state.accounts[accountId];
    if (!account) return;
    account.health = {
      ...account.health,
      state: "healthy",
      lastSuccessAt: new Date(now).toISOString(),
    };
    account.subscription = {
      ...account.subscription,
      status: "usable",
    };
    writeClaudeAccountPoolState(state, filePath);
  }, { filePath });
}

// Returns the account's session with a usable access token when one can be
// had. `force` refreshes even an unexpired token (the caller just saw it 401).
//
// Refresh tokens are single-use: Anthropic rotates them on every refresh. The
// forwarder, the usage probe, and `control` are separate processes, so the
// whole read-refresh-write sequence runs under a per-account file lock, and
// the credentials are re-read inside it. A process that waited on the lock
// finds the token another process already stored and uses it, instead of
// spending the rotated-away refresh token and earning an `invalid_grant` that
// would strike a perfectly healthy account.
//
// A session with `refreshFailed` set could not be refreshed: "invalid_grant"
// means the login is gone for good, anything else is transient.
export async function ensureFreshClaudeOAuthToken(accountId, {
  force = false,
  filePath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  now = Date.now(),
  tokenUrl = defaultTokenUrl(),
  clientId = OAUTH_CLIENT_ID,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (discoveryDisabled()) return undefined;

  const current = claudeOAuthSession(accountId, { filePath, homesDir, now });
  if (!force && current && !current.needsRefresh && current.accessToken) {
    return current;
  }

  if (!current?.refreshToken) {
    return current;
  }

  // Single-flight in-process promise map
  if (inFlightRefreshes.has(accountId)) {
    return await inFlightRefreshes.get(accountId);
  }

  const credPath = claudeSubscriptionAccountCredentialsPath(accountId, { homesDir });
  const refreshPromise = (async () => {
    try {
      return await withClaudeAccountPoolLock(async () => {
        const latest = claudeOAuthSession(accountId, { filePath, homesDir, now }) || current;
        // Another process refreshed while this one waited for the lock.
        const rotatedElsewhere = latest.tokenFingerprint !== current.tokenFingerprint;
        if (latest.accessToken && !latest.needsRefresh && (!force || rotatedElsewhere)) {
          return latest;
        }
        if (!latest.refreshToken) return latest;

        let response;
        try {
          response = await fetchImpl(tokenUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              grant_type: "refresh_token",
              refresh_token: latest.refreshToken,
              client_id: clientId,
            }),
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          // Network/timeout error: transient, the account stays eligible.
          return { ...latest, refreshFailed: "transient" };
        }

        let data;
        try {
          data = await response.json();
        } catch {}

        const newAccessToken = typeof data?.access_token === "string" ? data.access_token.trim() : "";
        if (response.ok && newAccessToken) {
          const expiresIn = Number(data.expires_in) || 3600;
          const newRefreshToken = typeof data.refresh_token === "string" ? data.refresh_token.trim() : "";
          let blob = {};
          if (existsSync(credPath)) {
            try {
              const raw = JSON.parse(readFileSync(credPath, "utf8"));
              blob = raw?.claudeAiOauth || raw || {};
            } catch {}
          }
          blob.accessToken = newAccessToken;
          blob.expiresAt = now + expiresIn * 1000;
          if (newRefreshToken) {
            blob.refreshToken = newRefreshToken;
          }
          if (data.scope) {
            blob.scope = data.scope;
          }
          writePrivateJson(credPath, { claudeAiOauth: blob }, { directoryMode: 0o700, fileMode: 0o600 });
          await markRefreshed(accountId, { filePath, now }).catch(() => {});
          return claudeOAuthSession(accountId, { filePath, homesDir, now });
        }

        // Handle failure per claude-swap taxonomy
        const status = response.status;
        const errorText = typeof data?.error === "string"
          ? data.error
          : typeof data?.error_code === "string"
            ? data.error_code
            : "";

        if ((status === 400 || status === 401 || status === 403) && errorText === "invalid_grant") {
          // Permanent failure: mark account reauth-required
          await markReauthRequired(accountId, { filePath, now, status }).catch(() => {});
          return { ...latest, refreshFailed: "invalid_grant" };
        }

        // invalid_client is systemic (not this account's fault); 5xx and a
        // 2xx without a token are transient. The account stays eligible.
        return { ...latest, refreshFailed: errorText || `http_${status}` };
      }, { filePath: credPath });
    } catch {
      // The lock itself failed: transient, return what we had.
      return { ...current, refreshFailed: "transient" };
    } finally {
      inFlightRefreshes.delete(accountId);
    }
  })();

  inFlightRefreshes.set(accountId, refreshPromise);
  return await refreshPromise;
}

export function clearInFlightRefreshesForTest() {
  inFlightRefreshes.clear();
}
