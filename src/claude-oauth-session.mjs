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

export async function ensureFreshClaudeOAuthToken(accountId, {
  force = false,
  filePath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  now = Date.now(),
  tokenUrl = OAUTH_TOKEN_URL,
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

  const refreshPromise = (async () => {
    try {
      const response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: clientId,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        const data = await response.json();
        const newAccessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
        const expiresIn = Number(data.expires_in) || 3600;
        const newRefreshToken = typeof data.refresh_token === "string" ? data.refresh_token.trim() : "";
        const newExpiresAt = now + expiresIn * 1000;

        return await withClaudeAccountPoolLock(async () => {
          const credPath = claudeSubscriptionAccountCredentialsPath(accountId, { homesDir });
          let blob = {};
          if (existsSync(credPath)) {
            try {
              const raw = JSON.parse(readFileSync(credPath, "utf8"));
              blob = raw?.claudeAiOauth || raw || {};
            } catch {}
          }
          blob.accessToken = newAccessToken;
          blob.expiresAt = newExpiresAt;
          if (newRefreshToken) {
            blob.refreshToken = newRefreshToken;
          }
          if (data.scope) {
            blob.scope = data.scope;
          }

          writePrivateJson(credPath, { claudeAiOauth: blob }, { directoryMode: 0o700, fileMode: 0o600 });

          const state = readClaudeAccountPoolState(filePath);
          const account = state.accounts[accountId];
          if (account) {
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
          }

          return claudeOAuthSession(accountId, { filePath, homesDir, now });
        }, { filePath });
      }

      // Handle failure per claude-swap taxonomy
      const status = response.status;
      let errorBody;
      try {
        errorBody = await response.json();
      } catch {}

      const errorText = typeof errorBody?.error === "string"
        ? errorBody.error
        : typeof errorBody?.error_code === "string"
          ? errorBody.error_code
          : "";

      if ((status === 400 || status === 401 || status === 403) && errorText === "invalid_grant") {
        // Permanent failure: mark account reauth-required
        await withClaudeAccountPoolLock(async () => {
          const state = readClaudeAccountPoolState(filePath);
          const account = state.accounts[accountId];
          if (account) {
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
          }
        }, { filePath });

        return claudeOAuthSession(accountId, { filePath, homesDir, now });
      }

      if (errorText === "invalid_client") {
        // Systemic client-id issue: do not strike the individual account
        return current;
      }

      // Transient failure (network, 5xx, etc.): account stays eligible with stale token
      return current;
    } catch {
      // Network/timeout error: transient, return current
      return current;
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
