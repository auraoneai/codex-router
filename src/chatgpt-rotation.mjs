// Rotation across the registered ChatGPT accounts.
//
// Upstream's account pool is a *switcher*: `selectedAccountId` names one
// account, `chatgpt-profile-switch` copies its credentials over
// `$CODEX_HOME/auth.json`, and every native request afterwards spends whatever
// that one file holds. That is correct but manual, so a weekly cap on the
// selected account answers 429 to the operator instead of moving to a
// subscription that still has room.
//
// This module restores automatic selection without disturbing that mechanism.
// It never writes `auth.json` and never switches a profile: it reads each
// account's own `auth.json` out of the pool's per-account home and returns the
// headers for the account it picked, which is what makes per-request rotation
// possible at all. Login, refresh, and locking stay upstream's job.
//
// Ordering, drain detection, cooldown, and conversation affinity are ported
// from the pre-0.6.0 custom implementation. The one adaptation is the quota
// shape: that code read `fiveHour`/`weekly`, while upstream's
// `normalizeCodexAccountUsage` reports `primary`/`secondary`. Both carry
// `remainingPercent`, so the rename is the whole difference.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CHATGPT_ACCOUNT_POOL_PATH,
  CHATGPT_ACCOUNT_HOMES_DIR,
} from "./paths.mjs";
import { readChatGPTAccountPoolState } from "./chatgpt-account-pool.mjs";
import { tokenExpiryMs } from "./codex-native-session.mjs";
import { nextKnownResetAt } from "./chatgpt-usage-probe.mjs";

export const ROTATION_STATE_VERSION = 1;

// A window at or below this is spent rather than nearly spent, so the account
// is removed from selection until a fresher probe says otherwise.
export const DRAINED_LEFTOVER_PERCENT = 0.5;
// Reported for operator visibility. Deliberately *not* used to move new work
// away from an otherwise preferred account: doing so strands the last slice of
// every subscription unspent.
export const SOFT_DRAIN_PERCENT = 15;
export const RESERVE_UNTIL_PERCENT = 20;
// A jump this large between probes means the window rolled over rather than
// drifted, which is how a paused reserve account earns its way back in.
export const RESET_JUMP_PERCENT = 25;
export const USAGE_CACHE_MAX_AGE_MS = 20 * 60 * 1000;
// How long an account that answered 429 is passed over. Long enough that a
// capped account is not retried on every turn, short enough that a five-hour
// window reopening is noticed promptly.
export const COOLDOWN_MS = 5 * 60 * 1000;
export const AFFINITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const AFFINITY_LIMIT = 200;

export const CHATGPT_ACCOUNT_PURPOSES = Object.freeze([
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
  return CHATGPT_ACCOUNT_PURPOSES.includes(purpose) ? purpose : undefined;
}

// Purpose drives pin order, and an operator who never set one still gets a
// stable ranking rather than registration order.
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

// Upstream names the two rate-limit windows `primary` and `secondary`; the
// custom implementation called them `fiveHour` and `weekly`. Accept either so a
// cache written by either generation reads correctly.
export function usageWindows(row) {
  return [row?.primary, row?.secondary, row?.fiveHour, row?.weekly].filter(
    (window) => window && Number.isFinite(window.remainingPercent),
  );
}

export function leftoverHealth(row, softDrainPercent = SOFT_DRAIN_PERCENT, accountId = row?.id) {
  if (accountId && isAccountAuthInvalid(accountId)) return "auth_invalid";
  if (row?.authInvalid === true) return "auth_invalid";
  if (row?.error && /401|token_revoked|invalidated oauth token|invalid_token|unauthorized/i.test(row.error)) {
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

// A window that jumped up by a wide margin rolled over rather than drifted.
export function windowReset(previous, current) {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
  return current - previous >= RESET_JUMP_PERCENT;
}

export function orderAccountCandidates(candidates, {
  sticky,
  preferred,
  usageById,
  order,
  purposeById,
  pinOrder = DEFAULT_PIN_ORDER,
  softDrainPercent = SOFT_DRAIN_PERCENT,
  now = Date.now(),
} = {}) {
  const usage = usageById instanceof Map ? usageById : new Map(Object.entries(usageById || {}));
  const purposes = purposeById instanceof Map ? purposeById : new Map(Object.entries(purposeById || {}));
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
  const purposeRank = (id) => pinIndex.get(purposes.get(id)) ?? 50;
  return [...candidates].sort((left, right) => {
    // An in-flight conversation outranks everything, provided the account
    // is not currently cooling down, auth-invalid, or completely drained.
    const rank = (entry) => {
      const quota = quotaRank(entry.id);
      const isCooled = (cooldowns.get(entry.id) || 0) > now;
      const isAuthInv = isAccountAuthInvalid(entry.id);
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
    const delta = rank(left) - rank(right);
    if (delta !== 0) return delta;
    const purposeDelta = purposeRank(left.id) - purposeRank(right.id);
    if (purposeDelta !== 0) return purposeDelta;
    return (orderIndex.get(left.id) ?? 999) - (orderIndex.get(right.id) ?? 999);
  });
}

export function pickAccount(candidateIds, options) {
  const ordered = orderAccountCandidates((candidateIds || []).map((id) => ({ id })), options);
  return ordered[0]?.id;
}

function accountAuthPath(accountId, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) {
  return path.join(homesDir, accountId, "auth.json");
}

// Reads one account's own credentials. Deliberately a plain read of the pool's
// per-account home: this must not consult `$CODEX_HOME/auth.json`, because the
// point of rotation is to reach an account *other* than the switched-in one.
export function accountSession(accountId, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const authPath = accountAuthPath(accountId, { homesDir });
  if (!existsSync(authPath)) return undefined;
  let document;
  try {
    document = JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    return undefined;
  }
  const tokens = document?.tokens;
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : undefined;
  if (!accessToken) return undefined;
  const expiry = tokenExpiryMs(accessToken);
  const accountIdClaim = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
  const tokenFingerprint = createHash("sha256").update(accessToken).digest("hex");
  const identityFingerprint = accountIdClaim
    ? createHash("sha256").update(accountIdClaim).digest("hex")
    : undefined;
  return {
    accountId: accountIdClaim,
    accessToken,
    expired: Number.isFinite(expiry) ? expiry <= now : false,
    tokenFingerprint,
    identityFingerprint,
    fingerprint: identityFingerprint,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(accountIdClaim ? { "chatgpt-account-id": accountIdClaim } : {}),
    },
  };
}

const cooldowns = new Map();
const affinities = new Map();
const authInvalidAccounts = new Map();

export function coolAccount(accountId, until) {
  if (!accountId) return;
  cooldowns.set(accountId, Math.max(cooldowns.get(accountId) || 0, until));
}

export function accountCooldownUntil(accountId) {
  return cooldowns.get(accountId) || 0;
}

export function markAccountAuthInvalid(accountId, { tokenFingerprint, reason } = {}) {
  if (!accountId) return;
  authInvalidAccounts.set(accountId, { at: Date.now(), tokenFingerprint, reason });
  forgetAccountAffinities(accountId);
}

export function clearAccountAuthInvalid(accountId) {
  if (!accountId) return;
  authInvalidAccounts.delete(accountId);
}

export function isAccountAuthInvalid(accountId, { tokenFingerprint } = {}) {
  if (!accountId) return false;
  const entry = authInvalidAccounts.get(accountId);
  if (!entry) return false;
  if (tokenFingerprint && entry.tokenFingerprint && tokenFingerprint !== entry.tokenFingerprint) {
    authInvalidAccounts.delete(accountId);
    return false;
  }
  return true;
}

export function rememberAccount(conversationId, accountId) {
  if (!conversationId || !accountId) return;
  affinities.set(String(conversationId), { accountId, at: Date.now() });
  if (affinities.size > AFFINITY_LIMIT) {
    const oldest = [...affinities.entries()].sort((left, right) => left[1].at - right[1].at);
    for (const [key] of oldest.slice(0, affinities.size - AFFINITY_LIMIT)) affinities.delete(key);
  }
}

export function rememberedAccount(conversationId, { now = Date.now() } = {}) {
  if (!conversationId) return undefined;
  const entry = affinities.get(String(conversationId));
  if (!entry) return undefined;
  if (now - entry.at > AFFINITY_MAX_AGE_MS) {
    affinities.delete(String(conversationId));
    return undefined;
  }
  return entry.accountId;
}

export function forgetAccountAffinities(accountId) {
  for (const [key, entry] of affinities) {
    if (entry.accountId === accountId) affinities.delete(key);
  }
}

export function findAccountByChatGPTAccountId(accountKey, {
  poolPath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
} = {}) {
  if (!accountKey) return undefined;
  let pool;
  try {
    pool = JSON.parse(readFileSync(poolPath, "utf8"));
  } catch {
    try {
      pool = readChatGPTAccountPoolState(poolPath);
    } catch {
      return undefined;
    }
  }
  for (const entry of Object.values(pool?.accounts || {})) {
    if (entry?.id === accountKey) return entry;
    if (entry?.identity?.accountId === accountKey) return entry;
    const session = accountSession(entry?.id, { homesDir });
    if (session?.accountId === accountKey) return entry;
  }
  return undefined;
}

// Exported for tests: rotation decisions must be reproducible without touching
// the real pool or the operator's credentials.
export function resetRotationStateForTests() {
  cooldowns.clear();
  affinities.clear();
  authInvalidAccounts.clear();
}

export function rotationCandidates({
  conversationId,
  poolPath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  usageById,
  now = Date.now(),
} = {}) {
  let pool;
  try {
    pool = readChatGPTAccountPoolState(poolPath);
  } catch {
    return [];
  }
  if (pool?.policy?.enabled === false) return [];
  const entries = Object.values(pool?.accounts || {});
  if (entries.length < 2) return [];
  const rules = normalizeRules(pool?.policy?.rules);
  const usage = usageById instanceof Map ? usageById : new Map(Object.entries(usageById || {}));
  const purposeById = new Map();
  const candidates = [];
  const seenFingerprints = new Set();
  for (const entry of entries) {
    if (entry?.state !== "active" || entry?.paused) continue;
    const session = accountSession(entry.id, { homesDir, now });
    if (!session || session.expired) continue;
    if (isAccountAuthInvalid(entry.id, { tokenFingerprint: session.tokenFingerprint })) continue;
    const cachedRow = usage.get(entry.id);
    if (cachedRow && accountIsAuthInvalid(cachedRow, entry.id)) continue;
    // Two registrations resolving to one ChatGPT identity are one quota, so
    // ranking both would just retry the same subscription.
    if (session.identityFingerprint && seenFingerprints.has(session.identityFingerprint)) continue;
    if (session.identityFingerprint) seenFingerprints.add(session.identityFingerprint);
    purposeById.set(entry.id, normalizePurpose(entry.purpose) || inferPurpose(entry.label, entry));
    candidates.push({
      id: entry.id,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(session.accountId ? { "chatgpt-account-id": session.accountId } : {}),
      },
    });
  }
  if (!candidates.length) return [];
  const ordered = orderAccountCandidates(candidates, {
    sticky: rememberedAccount(conversationId, { now, usageById: usage }),
    preferred: pool?.policy?.selectedAccountId,
    usageById: usage,
    order: entries.map((entry) => entry.id),
    purposeById,
    pinOrder: rules.pinOrder,
    softDrainPercent: rules.softDrainPercent,
  });
  // Drain is derived availability rather than persisted state: a spent account
  // drops out now and is admitted again by the next healthy probe, with no
  // operator action. With no usage data at all, every session stays eligible --
  // rotating blindly is still better than refusing to rotate.
  const eligible = usage.size
    ? ordered.filter((entry) => !accountIsDrained(usage.get(entry.id), rules.softDrainPercent, entry.id))
    : ordered;
  const ready = eligible.filter((entry) => (cooldowns.get(entry.id) || 0) <= now);
  // Falling back to `eligible` keeps a fully cooled-down pool usable: a stale
  // cooldown must not be the reason a request has no account at all.
  const usable = ready.length ? ready : eligible;
  return usable;
}

export function poolExhaustionReport({
  poolPath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  usageById,
  now = Date.now(),
} = {}) {
  let pool;
  try {
    pool = readChatGPTAccountPoolState(poolPath);
  } catch {
    return null;
  }
  if (pool?.policy?.enabled === false) return null;
  const entries = Object.values(pool?.accounts || {});
  if (entries.length < 2) return null;
  const rules = normalizeRules(pool?.policy?.rules);
  const usage = usageById instanceof Map ? usageById : new Map(Object.entries(usageById || {}));

  let healthy = 0;
  let soft = 0;
  let drained = 0;
  let authInvalid = 0;
  let cooling = 0;
  let expired = 0;
  let totalActive = 0;

  for (const entry of entries) {
    if (entry?.state !== "active" || entry?.paused) continue;
    totalActive++;
    const session = accountSession(entry.id, { homesDir, now });
    if (!session || session.expired) {
      expired++;
      continue;
    }
    if (isAccountAuthInvalid(entry.id, { tokenFingerprint: session.tokenFingerprint })) {
      authInvalid++;
      continue;
    }
    const cachedRow = usage.get(entry.id);
    if (cachedRow && accountIsAuthInvalid(cachedRow, entry.id)) {
      authInvalid++;
      continue;
    }
    if (cachedRow && accountIsDrained(cachedRow, rules.softDrainPercent, entry.id)) {
      drained++;
      continue;
    }
    const isCooling = (cooldowns.get(entry.id) || 0) > now;
    if (isCooling) {
      cooling++;
      continue;
    }
    const health = cachedRow ? leftoverHealth(cachedRow, rules.softDrainPercent, entry.id) : "unknown";
    if (health === "soft") soft++;
    else healthy++;
  }

  // If there are accounts that are healthy, soft, or unknown (not drained, cooling, or invalid)
  if (healthy > 0 || soft > 0 || totalActive === 0) {
    return null;
  }

  const nextReset = nextKnownResetAt(usage, { now });
  const resetIso = nextReset ? new Date(nextReset).toISOString() : null;

  return {
    exhausted: true,
    total: totalActive,
    healthy,
    soft,
    drained,
    authInvalid,
    cooling,
    expired,
    nextResetAt: nextReset,
    resetIso,
    message: `All ${totalActive} ChatGPT accounts in the pool are currently unavailable (${drained} quota-exhausted, ${authInvalid} auth invalid, ${cooling} cooling). Earliest quota reset: ${resetIso || "unknown"}.`,
  };
}
