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
    const fetchedAt = Date.parse(parsed?.fetchedAt);
    const fresh = Number.isFinite(fetchedAt) && now - fetchedAt <= USAGE_CACHE_MAX_AGE_MS;

    for (const account of parsed?.accounts || []) {
      if (!account?.id) continue;
      // Drop expired family readings older than FAMILY_STALE_MS
      if (account.fable?.seenAtMs && now - account.fable.seenAtMs > FAMILY_STALE_MS) {
        delete account.fable;
      }

      if (fresh) {
        byId.set(account.id, account);
      } else {
        // Retain drained or auth-invalid entries even when disk cache is stale
        const fiveHourDrained = account.fiveHour?.remainingPercent !== undefined && account.fiveHour.remainingPercent <= 0.5;
        const weeklyDrained = account.weekly?.remainingPercent !== undefined && account.weekly.remainingPercent <= 0.5;
        if (fiveHourDrained || weeklyDrained || account.authInvalid === true) {
          byId.set(account.id, account);
        }
      }
    }
  } catch {
    // Return empty map on failure
  }

  inMemoryCache = { at: now, byId };
  return byId;
}

export function recordClaudeAccountUsage(accountId, readingOrHeaders, {
  now = Date.now(),
  usagePath = CLAUDE_ACCOUNT_USAGE_CACHE_PATH,
  plan,
  email,
} = {}) {
  if (!accountId || !readingOrHeaders) return;

  const reading = (typeof readingOrHeaders.get === "function" ||
    (typeof readingOrHeaders === "object" && Object.keys(readingOrHeaders).some((k) => k.toLowerCase().startsWith("anthropic-ratelimit"))))
    ? parseClaudeUnifiedHeaders(readingOrHeaders)
    : readingOrHeaders;

  const current = readClaudeAccountUsageDocument(usagePath);
  const accountsMap = new Map((current.accounts || []).map((acc) => [acc.id, acc]));

  const existing = accountsMap.get(accountId) || { id: accountId };
  const updated = {
    ...existing,
    id: accountId,
    ...(plan ? { plan } : {}),
    ...(email ? { email } : {}),
    ...(reading.fiveHour ? { fiveHour: reading.fiveHour } : existing.fiveHour ? { fiveHour: existing.fiveHour } : {}),
    ...(reading.weekly ? { weekly: reading.weekly } : existing.weekly ? { weekly: existing.weekly } : {}),
    ...(reading.fable ? { fable: reading.fable } : existing.fable ? { fable: existing.fable } : {}),
    ...(reading.status ? { lastStatus: reading.status } : {}),
    updatedAt: new Date(now).toISOString(),
  };

  accountsMap.set(accountId, updated);

  const newDocument = {
    fetchedAt: new Date(now).toISOString(),
    accounts: Array.from(accountsMap.values()),
  };

  writePrivateJson(usagePath, newDocument, { directoryMode: 0o700, fileMode: 0o600 });
  inMemoryCache = { at: now, byId: new Map(accountsMap) };
}
