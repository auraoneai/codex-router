// Probes per-account Claude subscription quota so rotation can rank accounts.
//
// Read-only endpoint GET https://api.anthropic.com/api/oauth/usage per
// docs/CLAUDE-ACCOUNT-ROTATION-PRD.md §4.5. Outbound headers include
// `Authorization: Bearer ${accessToken}`, `anthropic-beta: oauth-2025-04-20`,
// `anthropic-version: 2023-06-01`, and `User-Agent: codex-router/${VERSION}`.
//
// Quota readings are parsed using `parseClaudeUnifiedHeaders` from
// `src/rate-limit-headers.mjs` or JSON response body if returned.
//
// Detects 401 / invalid_token / token_revoked and marks the account auth invalid
// via `markClaudeAccountAuthInvalid` in `src/claude-account-rotation.mjs`.

import { readFileSync } from "node:fs";

import {
  CLAUDE_ACCOUNT_HOMES_DIR,
  CLAUDE_ACCOUNT_POOL_PATH,
  CLAUDE_ACCOUNT_USAGE_CACHE_PATH,
} from "./paths.mjs";
import { readClaudeAccountPoolState } from "./claude-account-pool.mjs";
import {
  ensureFreshClaudeOAuthToken,
  OAUTH_BETA_HEADER,
} from "./claude-oauth-session.mjs";
import {
  clearClaudeAccountAuthInvalid,
  markClaudeAccountAuthInvalid,
} from "./claude-account-rotation.mjs";
import { parseClaudeUnifiedHeaders } from "./rate-limit-headers.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { invalidateClaudeAccountUsageCache } from "./claude-account-usage.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { VERSION } from "./version.mjs";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_PROBE_TIMEOUT_MS = 12_000;
export const USAGE_PROBE_LIMIT = 64;

function normalizeWindowJson(win) {
  if (!win || typeof win !== "object") return undefined;
  const used = win.utilization ?? win.used_percent ?? win.usedPercent;
  const remaining = win.remaining_percent ?? win.remainingPercent;
  const reset = win.reset ?? win.resets_at ?? win.resetsAt ?? win.resets_at_ms ?? win.resetsAtMs;
  let usedPercent;
  let remainingPercent;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    remainingPercent = remaining <= 1 ? Math.round(remaining * 100) : Math.round(remaining);
    usedPercent = Math.max(0, 100 - remainingPercent);
  } else if (typeof used === "number" && Number.isFinite(used)) {
    usedPercent = used <= 1 ? Math.round(used * 100) : Math.round(used);
    remainingPercent = Math.max(0, 100 - usedPercent);
  }
  let resetsAtMs;
  if (reset !== undefined && reset !== null && reset !== "") {
    const num = Number(reset);
    if (Number.isFinite(num) && num > 0) {
      resetsAtMs = num >= 1e12 ? num : num * 1000;
    }
  }
  if (usedPercent === undefined && remainingPercent === undefined && resetsAtMs === undefined) {
    return undefined;
  }
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

export function nextKnownClaudeResetAt(accounts, { now = Date.now() } = {}) {
  let earliest = null;
  const list = Array.isArray(accounts)
    ? accounts
    : accounts instanceof Map
    ? Array.from(accounts.values())
    : typeof accounts === "object" && accounts
    ? Object.values(accounts)
    : [];
  for (const acct of list) {
    const candidates = [
      acct?.fiveHour?.resetsAtMs,
      acct?.fiveHour?.resetsAt,
      acct?.weekly?.resetsAtMs,
      acct?.weekly?.resetsAt,
      acct?.fable?.resetsAtMs,
      acct?.fable?.resetsAt,
      acct?.usage?.fiveHour?.resetsAtMs,
      acct?.usage?.fiveHour?.resetsAt,
      acct?.usage?.weekly?.resetsAtMs,
      acct?.usage?.weekly?.resetsAt,
      acct?.usage?.fable?.resetsAtMs,
      acct?.usage?.fable?.resetsAt,
    ].filter((ts) => Number.isFinite(ts) && ts > 0);
    for (const ts of candidates) {
      const ms = ts < 100_000_000_000 ? ts * 1000 : ts;
      if (ms > now) {
        if (earliest === null || ms < earliest) {
          earliest = ms;
        }
      }
    }
  }
  return earliest;
}

let claudeResetProbeTimeout = null;

export function scheduleClaudeResetAwareProbe(resetsAtMs, {
  now = Date.now(),
  probe = probeClaudeAccountUsage,
  probeOptions,
} = {}) {
  if (!resetsAtMs || resetsAtMs <= now) return null;
  if (claudeResetProbeTimeout) {
    clearTimeout(claudeResetProbeTimeout);
    claudeResetProbeTimeout = null;
  }
  const delay = Math.max(1000, resetsAtMs - now + 5000); // 5s after reset
  if (delay > 24 * 60 * 60_000) return null; // Cap to 24h
  claudeResetProbeTimeout = setTimeout(async () => {
    try {
      await probe(probeOptions);
    } catch {}
  }, delay);
  claudeResetProbeTimeout.unref?.();
  return claudeResetProbeTimeout;
}

let lastClaudeEmergencyProbeAt = 0;

export function triggerClaudeEmergencyDepletionProbe({
  now = Date.now(),
  probe = probeClaudeAccountUsage,
  probeOptions,
} = {}) {
  if (now - lastClaudeEmergencyProbeAt < 30_000) return false; // 30s debounce
  lastClaudeEmergencyProbeAt = now;
  Promise.resolve(probe(probeOptions)).catch(() => {});
  return true;
}

let lastClaudePostTurnProbeAt = 0;
let claudePostTurnProbeTimer = null;

export function scheduleClaudePostTurnUsageProbe(delayMs = 15_000, {
  now = Date.now(),
  probe = probeClaudeAccountUsage,
  probeOptions,
} = {}) {
  if (now - lastClaudePostTurnProbeAt < 45_000) return null; // 45s debounce
  lastClaudePostTurnProbeAt = now;
  if (claudePostTurnProbeTimer) {
    clearTimeout(claudePostTurnProbeTimer);
    claudePostTurnProbeTimer = null;
  }
  claudePostTurnProbeTimer = setTimeout(async () => {
    lastClaudePostTurnProbeAt = Date.now();
    try {
      await probe(probeOptions);
    } catch {}
  }, delayMs);
  claudePostTurnProbeTimer.unref?.();
  return claudePostTurnProbeTimer;
}

export function resetClaudeProbeTimersForTest() {
  if (claudeResetProbeTimeout) {
    clearTimeout(claudeResetProbeTimeout);
    claudeResetProbeTimeout = null;
  }
  if (claudePostTurnProbeTimer) {
    clearTimeout(claudePostTurnProbeTimer);
    claudePostTurnProbeTimer = null;
  }
  lastClaudeEmergencyProbeAt = 0;
  lastClaudePostTurnProbeAt = 0;
}

export async function executeProbeClaudeAccountUsage({
  poolPath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  cachePath = CLAUDE_ACCOUNT_USAGE_CACHE_PATH,
  timeoutMs = USAGE_PROBE_TIMEOUT_MS,
  probeLimit = USAGE_PROBE_LIMIT,
  now = Date.now(),
  write = true,
  usageUrl = process.env.MODEL_ROUTER_CLAUDE_USAGE_URL || USAGE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (discoveryDisabled()) {
    return { version: 1, fetchedAt: new Date(now).toISOString(), accounts: [] };
  }

  let pool;
  try {
    pool = readClaudeAccountPoolState(poolPath);
  } catch {
    return { version: 1, fetchedAt: new Date(now).toISOString(), accounts: [] };
  }

  const selectedId = pool?.policy?.selectedAccountId;
  const candidates = Object.values(pool?.accounts || {})
    .filter((account) => account?.state === "active" && !account?.paused)
    .sort((left, right) => Number(right.id === selectedId) - Number(left.id === selectedId))
    .slice(0, Math.max(0, Math.floor(probeLimit)));

  let prevAccountsById = new Map();
  try {
    const prev = JSON.parse(readFileSync(cachePath, "utf8"));
    if (Array.isArray(prev?.accounts)) {
      for (const a of prev.accounts) {
        if (a?.id) prevAccountsById.set(a.id, a);
      }
    }
  } catch {
    // No previous cache
  }

  const probedAccounts = await Promise.all(candidates.map(async (account) => {
    const base = {
      id: account.id,
      label: account.label || "",
      state: account.state,
      preferred: account.id === selectedId,
    };
    const prev = prevAccountsById.get(account.id);

    try {
      const session = await ensureFreshClaudeOAuthToken(account.id, {
        filePath: poolPath,
        homesDir,
        now,
        fetchImpl,
      });

      if (!session?.accessToken) {
        const isAuthInvalid = account.health?.state === "reauth-required" || session?.expired;
        if (isAuthInvalid) {
          markClaudeAccountAuthInvalid(account.id, {
            tokenFingerprint: session?.tokenFingerprint,
            reason: "No valid access token available",
          });
        }
        return {
          ...base,
          fiveHour: !isAuthInvalid && prev?.fiveHour ? prev.fiveHour : null,
          weekly: !isAuthInvalid && prev?.weekly ? prev.weekly : null,
          fable: !isAuthInvalid && prev?.fable ? prev.fable : null,
          ...(isAuthInvalid ? { authInvalid: true, authErrorCode: "token_revoked" } : {}),
          error: "No access token available",
        };
      }

      const headers = {
        Authorization: `Bearer ${session.accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "anthropic-version": "2023-06-01",
        "User-Agent": `codex-router/${VERSION}`,
      };

      const response = await fetchImpl(usageUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      let body = null;
      try {
        body = await response.json();
      } catch {}

      const errorText = typeof body?.error === "string"
        ? body.error
        : typeof body?.error?.message === "string"
        ? body.error.message
        : typeof body?.error?.type === "string"
        ? body.error.type
        : typeof body?.message === "string"
        ? body.message
        : "";

      const isAuthInvalid = response.status === 401 ||
        /401|token_revoked|invalidated oauth token|invalid_token|unauthorized/i.test(errorText);

      if (isAuthInvalid) {
        markClaudeAccountAuthInvalid(account.id, {
          tokenFingerprint: session.tokenFingerprint,
          reason: errorText || `HTTP ${response.status}`,
        });
        return {
          ...base,
          fiveHour: prev?.fiveHour ?? null,
          weekly: prev?.weekly ?? null,
          fable: prev?.fable ?? null,
          authInvalid: true,
          authErrorCode: "token_revoked",
          error: errorText || `HTTP ${response.status}`,
        };
      }

      if (!response.ok) {
        const errorMsg = errorText || `HTTP ${response.status}`;
        return {
          ...base,
          fiveHour: prev?.fiveHour ?? null,
          weekly: prev?.weekly ?? null,
          fable: prev?.fable ?? null,
          error: errorMsg,
        };
      }

      clearClaudeAccountAuthInvalid(account.id);
      const headerReading = parseClaudeUnifiedHeaders(response.headers, { now });
      const fiveHour = headerReading?.fiveHour || normalizeWindowJson(body?.five_hour || body?.fiveHour) || prev?.fiveHour || null;
      const weekly = headerReading?.weekly || normalizeWindowJson(body?.seven_day || body?.weekly || body?.sevenDay) || prev?.weekly || null;
      const fable = headerReading?.fable || normalizeWindowJson(body?.seven_day_oi || body?.fable || body?.sevenDayOi) || prev?.fable || null;
      const status = headerReading?.status || body?.status || "allowed";
      const windowStatuses = headerReading?.windowStatuses || {};

      return {
        ...base,
        fiveHour,
        weekly,
        fable,
        status,
        windowStatuses,
        fetchedAt: new Date(now).toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Usage probe failed.";
      const isAuthInvalid = /401|token_revoked|invalidated oauth token|invalid_token|unauthorized/i.test(msg);
      if (isAuthInvalid) {
        markClaudeAccountAuthInvalid(account.id, {
          reason: msg,
        });
      }
      return {
        ...base,
        fiveHour: !isAuthInvalid && prev?.fiveHour ? prev.fiveHour : null,
        weekly: !isAuthInvalid && prev?.weekly ? prev.weekly : null,
        fable: !isAuthInvalid && prev?.fable ? prev.fable : null,
        ...(isAuthInvalid ? { authInvalid: true, authErrorCode: "token_revoked" } : {}),
        error: msg,
      };
    }
  }));

  const finalAccountsMap = new Map(prevAccountsById);
  for (const acct of probedAccounts) {
    finalAccountsMap.set(acct.id, acct);
  }
  for (const id of finalAccountsMap.keys()) {
    if (!pool?.accounts?.[id]) {
      finalAccountsMap.delete(id);
    }
  }

  const accounts = Array.from(finalAccountsMap.values());
  const snapshot = {
    version: 1,
    fetchedAt: new Date(now).toISOString(),
    accounts,
  };

  if (write) {
    try {
      writePrivateJson(cachePath, snapshot, { directoryMode: 0o700, fileMode: 0o600 });
      invalidateClaudeAccountUsageCache();
    } catch {
      // Degrades gracefully
    }
  }

  return snapshot;
}

const inFlightProbes = new Map();

export async function probeClaudeAccountUsage(options = {}) {
  const key = options.cachePath || CLAUDE_ACCOUNT_USAGE_CACHE_PATH;
  if (inFlightProbes.has(key)) {
    if (!options.freshAfterInFlight) return inFlightProbes.get(key);
    await inFlightProbes.get(key).catch(() => {});
  }
  const promise = executeProbeClaudeAccountUsage(options).finally(() => {
    inFlightProbes.delete(key);
  });
  inFlightProbes.set(key, promise);
  return promise;
}

export function clearInFlightProbesForTest() {
  inFlightProbes.clear();
}
