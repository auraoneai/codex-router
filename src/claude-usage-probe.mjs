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
import {
  claudeUsageRowObservedAtMs,
  invalidateClaudeAccountUsageCache,
  readClaudeAccountUsageDocument,
} from "./claude-account-usage.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { VERSION } from "./version.mjs";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_PROBE_TIMEOUT_MS = 12_000;
export const USAGE_PROBE_LIMIT = 64;

// Ties a cached auth-invalid row to the token that failed, so a refreshed or
// re-imported login is not held out by a verdict about its predecessor. A
// prefix of a SHA-256 of the token: enough to tell tokens apart, useless as
// a credential.
function authFingerprintPrefix(tokenFingerprint) {
  return typeof tokenFingerprint === "string" && tokenFingerprint ? tokenFingerprint.slice(0, 16) : undefined;
}

function normalizeWindowJson(win, limit) {
  if (!win && !limit) return undefined;
  const used = limit?.percent ?? win?.utilization ?? win?.used_percent ?? win?.usedPercent;
  const remaining = win?.remaining_percent ?? win?.remainingPercent;
  const reset = limit?.resets_at ?? limit?.resetsAt ?? win?.reset ?? win?.resets_at ?? win?.resetsAt ?? win?.resets_at_ms ?? win?.resetsAtMs;
  let usedPercent;
  let remainingPercent;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    remainingPercent = (remaining > 0 && remaining < 1) ? Math.round(remaining * 100) : Math.round(remaining);
    usedPercent = Math.max(0, 100 - remainingPercent);
  } else if (typeof used === "number" && Number.isFinite(used)) {
    // Anthropic returns utilization in 0..100 percentage space (e.g. 1.0 for 1%, 4.0 for 4%, 100 for 100%).
    // Test mocks occasionally supply fractional decimals strictly between 0 and 1 (e.g. 0.15 for 15%).
    usedPercent = (used > 0 && used < 1) ? Math.round(used * 100) : Math.min(100, Math.max(0, Math.round(used)));
    remainingPercent = Math.max(0, 100 - usedPercent);
  }
  let resetsAtMs;
  if (reset !== undefined && reset !== null && reset !== "") {
    const parsed = typeof reset === "string" ? Date.parse(reset) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      resetsAtMs = parsed;
    } else {
      const num = Number(reset);
      if (Number.isFinite(num) && num > 0) {
        resetsAtMs = num >= 1e12 ? num : num * 1000;
      }
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
    const prev = prevAccountsById.get(account.id);
    const base = {
      id: account.id,
      label: account.label || "",
      state: account.state,
      preferred: account.id === selectedId,
      ...(account.subscription?.plan || prev?.plan ? { plan: account.subscription?.plan || prev?.plan } : {}),
      ...(account.identity?.email || prev?.email ? { email: account.identity?.email || prev?.email } : {}),
    };

    try {
      const session = await ensureFreshClaudeOAuthToken(account.id, {
        filePath: poolPath,
        homesDir,
        now,
        fetchImpl,
      });

      const reauthRequired = session?.refreshFailed === "invalid_grant" ||
        (account.health?.state === "reauth-required" && (!session?.accessToken || session?.expired));
      if (reauthRequired) {
        markClaudeAccountAuthInvalid(account.id, {
          tokenFingerprint: session?.tokenFingerprint,
          reason: "invalid_grant: reauthentication required",
        });
        return {
          ...base,
          fiveHour: null,
          weekly: null,
          fable: null,
          authInvalid: true,
          authErrorCode: "token_revoked",
          ...(authFingerprintPrefix(session?.tokenFingerprint)
            ? { authTokenFingerprint: authFingerprintPrefix(session.tokenFingerprint) }
            : {}),
          error: "Reauthentication required",
          fetchedAt: new Date(now).toISOString(),
        };
      }
      // No token, or an expired one whose refresh failed transiently: probing
      // with it would only earn a 401 that says nothing about the login. Keep
      // the last reading and try again next round.
      if (!session?.accessToken || session?.expired) {
        return {
          ...base,
          fiveHour: prev?.fiveHour ?? null,
          weekly: prev?.weekly ?? null,
          fable: prev?.fable ?? null,
          error: "No access token available",
          ...(prev?.updatedAt ? { updatedAt: prev.updatedAt } : {}),
          ...(prev?.fetchedAt ? { fetchedAt: prev.fetchedAt } : {}),
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
          ...(authFingerprintPrefix(session.tokenFingerprint)
            ? { authTokenFingerprint: authFingerprintPrefix(session.tokenFingerprint) }
            : {}),
          error: errorText || `HTTP ${response.status}`,
          fetchedAt: new Date(now).toISOString(),
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
      const sessionLimit = Array.isArray(body?.limits)
        ? body.limits.find((l) => l?.group === "session" || l?.kind === "session")
        : undefined;
      const weeklyLimit = Array.isArray(body?.limits)
        ? body.limits.find((l) => l?.group === "weekly" || l?.kind === "weekly_all" || l?.kind === "weekly")
        : undefined;
      const fiveHour = headerReading?.fiveHour || normalizeWindowJson(body?.five_hour || body?.fiveHour, sessionLimit) || prev?.fiveHour || null;
      const weekly = headerReading?.weekly || normalizeWindowJson(body?.seven_day || body?.weekly || body?.sevenDay, weeklyLimit) || prev?.weekly || null;
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

  // The forwarder records passive readings while the probe is in flight.
  // Re-read the document now and keep whichever row learned something later,
  // so a probe that started before a response never overwrites its reading.
  const finalAccountsMap = new Map(prevAccountsById);
  let latestDocument;
  try {
    latestDocument = readClaudeAccountUsageDocument(cachePath);
    for (const row of latestDocument?.accounts || []) {
      if (row?.id) finalAccountsMap.set(row.id, row);
    }
  } catch {}
  const probeStartedAt = now;
  for (const acct of probedAccounts) {
    const concurrent = finalAccountsMap.get(acct.id);
    const concurrentAt = concurrent
      ? claudeUsageRowObservedAtMs(concurrent, latestDocument?.fetchedAt)
      : undefined;
    if (concurrent && Number.isFinite(concurrentAt) && concurrentAt > probeStartedAt) continue;
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
