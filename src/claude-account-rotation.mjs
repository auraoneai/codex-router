import { createHash } from "node:crypto";
import path from "node:path";

import {
  CLAUDE_ACCOUNT_HOMES_DIR,
  CLAUDE_ACCOUNT_POOL_PATH,
} from "./paths.mjs";
import { readClaudeAccountPoolState } from "./claude-account-pool.mjs";
import { claudeOAuthSession } from "./claude-oauth-session.mjs";

export const ROTATION_STATE_VERSION = 1;

export const DRAINED_LEFTOVER_PERCENT = 0.5;
export const SOFT_DRAIN_PERCENT = 15;
export const RESERVE_UNTIL_PERCENT = 20;
export const RESET_JUMP_PERCENT = 25;
export const USAGE_CACHE_MAX_AGE_MS = 20 * 60 * 1000;
export const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
export const AUTH_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
export const AFFINITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const AFFINITY_LIMIT = 200;

export const CLAUDE_ACCOUNT_PURPOSES = Object.freeze([
  "personal",
  "auraone",
  "veerone",
  "foundation",
  "reserve",
]);

export const DEFAULT_PIN_ORDER = Object.freeze([
  "personal",
  "auraone",
  "veerone",
  "foundation",
]);

export function normalizePurpose(value) {
  const purpose = String(value || "").trim().toLowerCase();
  return CLAUDE_ACCOUNT_PURPOSES.includes(purpose) ? purpose : undefined;
}

export function inferPurpose(label, { id, state } = {}) {
  const text = `${label || ""} ${id || ""}`.toLowerCase();
  if (text.includes("auraone")) return "auraone";
  if (text.includes("veerone")) return "veerone";
  if (text.includes("foundation") || text.includes("chahalfoundation")) return "foundation";
  if (state === "paused" || text.includes("backup") || text.includes("reserve")) return "reserve";
  return "personal";
}

export function normalizeRules(rules) {
  const pinOrder = Array.isArray(rules?.pinOrder)
    ? rules.pinOrder.map(normalizePurpose).filter(Boolean)
    : [];
  const seen = new Set();
  const pins = [...pinOrder, ...DEFAULT_PIN_ORDER].filter((purpose) => {
    if (seen.has(purpose) || purpose === "reserve") return false;
    seen.add(purpose);
    return true;
  });
  const softDrainPercent = Number(rules?.softDrainPercent);
  const reserveUntilPercent = Number(rules?.reserveUntilPercent);
  return {
    pinOrder: pins,
    softDrainPercent: Number.isFinite(softDrainPercent)
      ? Math.min(40, Math.max(1, softDrainPercent))
      : SOFT_DRAIN_PERCENT,
    reserveUntilPercent: Number.isFinite(reserveUntilPercent)
      ? Math.min(80, Math.max(1, reserveUntilPercent))
      : RESERVE_UNTIL_PERCENT,
    autoResumeOnReset: rules?.autoResumeOnReset !== false,
  };
}

export function usageWindows(row) {
  return [row?.fiveHour, row?.weekly, row?.primary, row?.secondary].filter(
    (window) => window && Number.isFinite(window.remainingPercent),
  );
}

export function leftoverHealth(row, softDrainPercent = SOFT_DRAIN_PERCENT, accountId = row?.id) {
  if (accountId && isClaudeAccountAuthInvalid(accountId)) return "auth_invalid";
  if (row?.authInvalid === true) return "auth_invalid";
  if (row?.error && /401|token_revoked|invalidated oauth token|invalid_grant|invalid_token|unauthorized/i.test(row.error)) {
    return "auth_invalid";
  }
  const windows = usageWindows(row);
  if (!windows.length) return "unknown";
  if (windows.some((window) => window.remainingPercent <= DRAINED_LEFTOVER_PERCENT)) return "drained";
  if (windows.some((window) => window.remainingPercent <= softDrainPercent)) return "soft";
  return "healthy";
}

export function accountIsDrained(row, softDrainPercent = SOFT_DRAIN_PERCENT, accountId = row?.id) {
  return leftoverHealth(row, softDrainPercent, accountId) === "drained";
}

export function accountIsAuthInvalid(row, accountId = row?.id) {
  return leftoverHealth(row, undefined, accountId) === "auth_invalid";
}

export function windowReset(previous, current) {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
  return current - previous >= RESET_JUMP_PERCENT;
}

export function tierWeight(plan) {
  const p = String(plan || "").trim().toLowerCase();
  if (p === "pro") return 1;
  if (p === "max5") return 5;
  if (p === "max20") return 20;
  if (p === "team") return 50;
  return 3; // unknown sits between pro and max5
}

const cooldowns = new Map();
const affinities = new Map();
const authInvalidAccounts = new Map();

export function coolClaudeAccount(accountId, until) {
  if (!accountId) return;
  cooldowns.set(accountId, Math.max(cooldowns.get(accountId) || 0, until));
}

export function claudeAccountCooldownUntil(accountId) {
  return cooldowns.get(accountId) || 0;
}

export function markClaudeAccountAuthInvalid(accountId, { tokenFingerprint, reason } = {}) {
  if (!accountId) return;
  authInvalidAccounts.set(accountId, { at: Date.now(), tokenFingerprint, reason });
  forgetClaudeAccountAffinities(accountId);
}

export function clearClaudeAccountAuthInvalid(accountId) {
  if (!accountId) return;
  authInvalidAccounts.delete(accountId);
}

export function isClaudeAccountAuthInvalid(accountId, { tokenFingerprint } = {}) {
  if (!accountId) return false;
  const entry = authInvalidAccounts.get(accountId);
  if (!entry) return false;
  if (tokenFingerprint && entry.tokenFingerprint && tokenFingerprint !== entry.tokenFingerprint) {
    authInvalidAccounts.delete(accountId);
    return false;
  }
  return true;
}

export function rememberClaudeAccount(conversationId, accountId) {
  if (!conversationId || !accountId) return;
  affinities.set(String(conversationId), { accountId, at: Date.now() });
  if (affinities.size > AFFINITY_LIMIT) {
    const oldest = [...affinities.entries()].sort((left, right) => left[1].at - right[1].at);
    for (const [key] of oldest.slice(0, affinities.size - AFFINITY_LIMIT)) affinities.delete(key);
  }
}

export function rememberedClaudeAccount(conversationId, { now = Date.now() } = {}) {
  if (!conversationId) return undefined;
  const entry = affinities.get(String(conversationId));
  if (!entry) return undefined;
  if (now - entry.at > AFFINITY_MAX_AGE_MS) {
    affinities.delete(String(conversationId));
    return undefined;
  }
  return entry.accountId;
}

export function forgetClaudeAccountAffinities(accountId) {
  for (const [key, entry] of affinities) {
    if (entry.accountId === accountId) affinities.delete(key);
  }
}

export function resetClaudeRotationStateForTests() {
  cooldowns.clear();
  affinities.clear();
  authInvalidAccounts.clear();
}

export function claudeAccountSession(accountId, {
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  now = Date.now(),
} = {}) {
  const session = claudeOAuthSession(accountId, { homesDir, now });
  if (!session) return undefined;
  return {
    accountId: session.accountId,
    accessToken: session.accessToken,
    tokenFingerprint: session.tokenFingerprint,
    identityFingerprint: session.identityFingerprint,
    headers: session.headers,
    expiresAtMs: session.expiresAtMs,
    expired: session.expired,
  };
}

export function orderClaudeAccountCandidates(candidates, {
  sticky,
  preferred,
  usageById,
  order,
  purposeById,
  planById,
  pinOrder = DEFAULT_PIN_ORDER,
  softDrainPercent = SOFT_DRAIN_PERCENT,
  now = Date.now(),
} = {}) {
  const usage = usageById instanceof Map ? usageById : new Map(Object.entries(usageById || {}));
  const purposes = purposeById instanceof Map ? purposeById : new Map(Object.entries(purposeById || {}));
  const plans = planById instanceof Map ? planById : new Map(Object.entries(planById || {}));
  const orderIndex = new Map((order || []).map((id, index) => [id, index]));
  const pinIndex = new Map((pinOrder || DEFAULT_PIN_ORDER).map((purpose, index) => [purpose, index]));

  const quotaRank = (id) => {
    const health = leftoverHealth(usage.get(id), softDrainPercent, id);
    if (health === "healthy") return 1;
    if (health === "soft") return 2;
    if (health === "unknown") return 3;
    if (health === "drained") return 4;
    return 5;
  };

  const planRank = (id) => {
    const planFromUsage = usage.get(id)?.plan || usage.get(id)?.planType;
    const plan = planFromUsage || plans.get(id);
    return tierWeight(plan);
  };

  const purposeRank = (id) => pinIndex.get(purposes.get(id)) ?? 50;

  return [...candidates].sort((left, right) => {
    const rank = (entry) => {
      const quota = quotaRank(entry.id);
      const isCooled = (cooldowns.get(entry.id) || 0) > now;
      const isAuthInv = isClaudeAccountAuthInvalid(entry.id);
      if (entry.id === sticky && !isCooled && !isAuthInv && quota !== 4 && quota !== 5) return 0;
      const home = entry.id === preferred;
      if ((quota === 1 || quota === 2) && home) return 1;
      if (quota === 1) return 2;
      if (quota === 2) return 3;
      if (quota === 3 && home) return 4;
      if (quota === 3) return 5;
      if (home) return 6;
      return 7;
    };

    const leftRank = rank(left);
    const rightRank = rank(right);

    if (leftRank !== 0 && rightRank !== 0 &&
        leftRank >= 1 && leftRank <= 3 && rightRank >= 1 && rightRank <= 3) {
      const tierDelta = planRank(left.id) - planRank(right.id);
      if (tierDelta !== 0) return tierDelta;
    }

    const delta = leftRank - rightRank;
    if (delta !== 0) return delta;

    const purposeDelta = purposeRank(left.id) - purposeRank(right.id);
    if (purposeDelta !== 0) return purposeDelta;

    return (orderIndex.get(left.id) ?? 999) - (orderIndex.get(right.id) ?? 999);
  });
}

export function pickClaudeAccount(candidateIds, options) {
  const ordered = orderClaudeAccountCandidates((candidateIds || []).map((id) => ({ id })), options);
  return ordered[0]?.id;
}

export function claudeRotationCandidates({
  conversationId,
  poolPath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  usageById,
  now = Date.now(),
} = {}) {
  let pool;
  try {
    pool = readClaudeAccountPoolState(poolPath);
  } catch {
    return [];
  }
  if (pool?.policy?.enabled === false) return [];
  const entries = Object.values(pool?.accounts || {});
  if (entries.length === 0) return [];

  const usage = usageById instanceof Map ? usageById : new Map(Object.entries(usageById || {}));
  const purposeById = new Map();
  const planById = new Map();
  const candidates = [];
  const seenFingerprints = new Set();

  for (const entry of entries) {
    if (entry?.state !== "active" || entry?.paused) continue;
    const session = claudeOAuthSession(entry.id, { homesDir, now });
    if (!session || session.expired || !session.accessToken) continue;

    // Check auth invalid
    if (isClaudeAccountAuthInvalid(entry.id, { tokenFingerprint: session.tokenFingerprint })) continue;
    const cachedRow = usage.get(entry.id);
    if (cachedRow && accountIsAuthInvalid(cachedRow, entry.id)) continue;

    // Identity fingerprint de-dup
    if (session.identityFingerprint && seenFingerprints.has(session.identityFingerprint)) continue;
    if (session.identityFingerprint) seenFingerprints.add(session.identityFingerprint);

    purposeById.set(entry.id, normalizePurpose(entry.purpose) || inferPurpose(entry.label, entry));
    planById.set(entry.id, entry.subscription?.plan);

    candidates.push({
      id: entry.id,
      headers: session.headers,
    });
  }

  if (!candidates.length) return [];

  const ordered = orderClaudeAccountCandidates(candidates, {
    sticky: rememberedClaudeAccount(conversationId, { now }),
    preferred: pool?.policy?.selectedAccountId,
    usageById: usage,
    order: entries.map((entry) => entry.id),
    purposeById,
    planById,
    pinOrder: DEFAULT_PIN_ORDER,
    softDrainPercent: SOFT_DRAIN_PERCENT,
    now,
  });

  const eligible = usage.size
    ? ordered.filter((entry) => !accountIsDrained(usage.get(entry.id), SOFT_DRAIN_PERCENT, entry.id))
    : ordered;
  const ready = eligible.filter((entry) => (cooldowns.get(entry.id) || 0) <= now);
  const usable = ready.length ? ready : eligible;
  return usable;
}

export function claudePoolExhaustionReport({
  poolPath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  usageById,
  now = Date.now(),
} = {}) {
  let pool;
  try {
    pool = readClaudeAccountPoolState(poolPath);
  } catch {
    return null;
  }
  if (pool?.policy?.enabled === false) return null;
  const entries = Object.values(pool?.accounts || {});
  if (entries.length === 0) return null;

  const usage = usageById instanceof Map ? usageById : new Map(Object.entries(usageById || {}));

  let healthy = 0;
  let soft = 0;
  let drained = 0;
  let authInvalid = 0;
  let cooling = 0;
  let expired = 0;
  let totalActive = 0;

  let earliestResetMs = null;

  for (const entry of entries) {
    if (entry?.state !== "active" || entry?.paused) continue;
    totalActive++;
    const session = claudeOAuthSession(entry.id, { homesDir, now });
    if (!session || session.expired || !session.accessToken) {
      expired++;
      continue;
    }
    if (isClaudeAccountAuthInvalid(entry.id, { tokenFingerprint: session.tokenFingerprint })) {
      authInvalid++;
      continue;
    }
    const cachedRow = usage.get(entry.id);
    if (cachedRow && accountIsAuthInvalid(cachedRow, entry.id)) {
      authInvalid++;
      continue;
    }
    if (cachedRow && accountIsDrained(cachedRow, SOFT_DRAIN_PERCENT, entry.id)) {
      drained++;
      const reset = cachedRow.fiveHour?.resetsAtMs || cachedRow.weekly?.resetsAtMs;
      if (reset && (!earliestResetMs || reset < earliestResetMs)) {
        earliestResetMs = reset;
      }
      continue;
    }
    const isCooling = (cooldowns.get(entry.id) || 0) > now;
    if (isCooling) {
      cooling++;
      const cd = cooldowns.get(entry.id);
      if (cd && (!earliestResetMs || cd < earliestResetMs)) {
        earliestResetMs = cd;
      }
      continue;
    }
    const health = cachedRow ? leftoverHealth(cachedRow, SOFT_DRAIN_PERCENT, entry.id) : "unknown";
    if (health === "soft") soft++;
    else healthy++;
  }

  if (healthy > 0 || soft > 0 || totalActive === 0) {
    return null;
  }

  const resetIso = earliestResetMs ? new Date(earliestResetMs).toISOString() : null;

  return {
    exhausted: true,
    total: totalActive,
    healthy,
    soft,
    drained,
    authInvalid,
    cooling,
    expired,
    nextResetAt: earliestResetMs,
    resetIso,
    message: `All ${totalActive} Claude accounts in the pool are currently unavailable (${drained} quota-exhausted, ${authInvalid} auth invalid, ${cooling} cooling). Earliest quota reset: ${resetIso || "unknown"}.`,
  };
}
