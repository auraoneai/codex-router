import { existsSync, lstatSync, readFileSync } from "node:fs";

import { CLAUDE_ACCOUNT_USAGE_CACHE_PATH } from "./paths.mjs";
import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";
import { parseClaudeUnifiedHeaders } from "./rate-limit-headers.mjs";

export const USAGE_CACHE_MAX_AGE_MS = 20 * 60 * 1000; // 20 minutes
export const IN_MEMORY_CACHE_TTL_MS = 30_000; // 30 seconds
export const FAMILY_STALE_MS = 30 * 60 * 1000; // 30 minutes for spent 7d_oi Fable reading

let inMemoryCache = { at: 0, byId: new Map() };

export function clearClaudeAccountUsageCacheForTests() {
  inMemoryCache = { at: 0, byId: new Map() };
}

export function invalidateClaudeAccountUsageCache() {
  inMemoryCache = { at: 0, byId: new Map() };
}

export function readClaudeAccountUsageDocument(usagePath = CLAUDE_ACCOUNT_USAGE_CACHE_PATH) {
  if (!existsSync(usagePath)) return { fetchedAt: new Date().toISOString(), accounts: [] };
  try {
    const file = lstatSync(usagePath);
    if (file.isSymbolicLink() || !file.isFile()) {
      return { fetchedAt: new Date().toISOString(), accounts: [] };
    }
    return JSON.parse(readFileSync(usagePath, "utf8"));
  } catch {
    return { fetchedAt: new Date().toISOString(), accounts: [] };
  }
}

// When a row last learned anything. Rows carry their own time because
// passive telemetry updates one account per response: a document-level stamp
// would make every other account's reading look as fresh as the newest one.
export function claudeUsageRowObservedAtMs(row, documentFetchedAt) {
  for (const value of [row?.updatedAt, row?.fetchedAt, documentFetchedAt]) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function liveDrainedWindow(window, now) {
  if (!window || !Number.isFinite(window.remainingPercent) || window.remainingPercent > 0.5) return false;
  const resetsAtMs = Number(window.resetsAtMs);
  return !(Number.isFinite(resetsAtMs) && resetsAtMs > 0 && resetsAtMs <= now);
}

export function cachedClaudeAccountUsageById({
  now = Date.now(),
  usagePath = CLAUDE_ACCOUNT_USAGE_CACHE_PATH,
  force = false,
} = {}) {
  if (!force && now - inMemoryCache.at < IN_MEMORY_CACHE_TTL_MS) {
    return inMemoryCache.byId;
  }

  const byId = new Map();
  try {
    const parsed = readClaudeAccountUsageDocument(usagePath);

    for (const account of parsed?.accounts || []) {
      if (!account?.id) continue;
      // Drop expired family readings older than FAMILY_STALE_MS
      if (account.fable?.seenAtMs && now - account.fable.seenAtMs > FAMILY_STALE_MS) {
        delete account.fable;
      }

      const observedAt = claudeUsageRowObservedAtMs(account, parsed?.fetchedAt);
      const fresh = Number.isFinite(observedAt) && now - observedAt <= USAGE_CACHE_MAX_AGE_MS;
      if (fresh) {
        byId.set(account.id, account);
      } else if (
        // A stale row still keeps a spent or refused account out, but only
        // while the spent window has not reset yet.
        liveDrainedWindow(account.fiveHour, now) ||
        liveDrainedWindow(account.weekly, now) ||
        account.authInvalid === true
      ) {
        byId.set(account.id, account);
      }
    }
  } catch {
    // Return empty map on failure
  }

  inMemoryCache = { at: now, byId };
  return byId;
}

// Records the unified quota reading one upstream response carried. Any
// response that is not a 401 proves the token works, so a stale auth-invalid
// flag or error from an earlier probe is cleared rather than carried forward.
export function recordClaudeAccountUsage(accountId, readingOrHeaders, {
  now = Date.now(),
  usagePath = CLAUDE_ACCOUNT_USAGE_CACHE_PATH,
  plan,
  email,
  authOk = true,
} = {}) {
  if (!accountId || !readingOrHeaders) return;

  const reading = (typeof readingOrHeaders.get === "function" ||
    (typeof readingOrHeaders === "object" && Object.keys(readingOrHeaders).some((k) => k.toLowerCase().startsWith("anthropic-ratelimit"))))
    ? parseClaudeUnifiedHeaders(readingOrHeaders, { now })
    : readingOrHeaders;
  if (!reading && !authOk) return;

  const current = readClaudeAccountUsageDocument(usagePath);
  const accountsMap = new Map((current.accounts || []).map((acc) => [acc.id, acc]));

  const existing = { ...(accountsMap.get(accountId) || { id: accountId }) };
  if (authOk) {
    delete existing.authInvalid;
    delete existing.authErrorCode;
    delete existing.authTokenFingerprint;
    delete existing.error;
  }
  const r = reading || {};
  const updated = {
    ...existing,
    id: accountId,
    ...(plan ? { plan } : {}),
    ...(email ? { email } : {}),
    ...(r.fiveHour ? { fiveHour: r.fiveHour } : existing.fiveHour ? { fiveHour: existing.fiveHour } : {}),
    ...(r.weekly ? { weekly: r.weekly } : existing.weekly ? { weekly: existing.weekly } : {}),
    ...(r.fable ? { fable: r.fable } : existing.fable ? { fable: existing.fable } : {}),
    ...(r.status ? { lastStatus: r.status, status: r.status } : {}),
    ...(r.windowStatuses && Object.keys(r.windowStatuses).length ? { windowStatuses: r.windowStatuses } : {}),
    updatedAt: new Date(now).toISOString(),
  };

  accountsMap.set(accountId, updated);

  const newDocument = {
    ...current,
    fetchedAt: new Date(now).toISOString(),
    accounts: Array.from(accountsMap.values()),
  };

  writePrivateJson(usagePath, newDocument, { directoryMode: 0o700, fileMode: 0o600 });
  // The next read re-applies the per-row freshness rules to the new document.
  invalidateClaudeAccountUsageCache();
}
