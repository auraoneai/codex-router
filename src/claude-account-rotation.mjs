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

// A window whose reset time has passed no longer describes the account: the
// quota it measured rolled over. It reads as unknown until the next response
// or probe reports the new window, so a drained account is admitted again the
// moment its window resets instead of waiting on a probe nobody schedules.
export function windowIsLive(window, now = Date.now()) {
  if (!window || !Number.isFinite(window.remainingPercent)) return false;
  const resetsAtMs = Number(window.resetsAtMs);
  return !(Number.isFinite(resetsAtMs) && resetsAtMs > 0 && resetsAtMs <= now);
}

export function usageWindows(row, now = Date.now()) {
  return [row?.fiveHour, row?.weekly, row?.primary, row?.secondary].filter(
    (window) => windowIsLive(window, now),
  );
}

// A cached auth-invalid row describes the token that failed. Once the account
// holds a different token (refreshed, or re-imported after a new login) the
// row no longer applies.
export function rowAuthInvalid(row, tokenFingerprint) {
  const flagged = row?.authInvalid === true ||
    Boolean(row?.error && /401|token_revoked|invalidated oauth token|invalid_grant|invalid_token|unauthorized/i.test(row.error));
  if (!flagged) return false;
  if (tokenFingerprint && row?.authTokenFingerprint &&
      !tokenFingerprint.startsWith(row.authTokenFingerprint)) {
    return false;
  }
  return true;
}

export function leftoverHealth(row, softDrainPercent = SOFT_DRAIN_PERCENT, accountId = row?.id, {
  now = Date.now(),
  tokenFingerprint,
} = {}) {
  if (accountId && isClaudeAccountAuthInvalid(accountId, { tokenFingerprint })) return "auth_invalid";
  if (rowAuthInvalid(row, tokenFingerprint)) return "auth_invalid";
  const windows = usageWindows(row, now);
  if (!windows.length) return "unknown";
  if (windows.some((window) => window.remainingPercent <= DRAINED_LEFTOVER_PERCENT)) return "drained";
  if (windows.some((window) => window.remainingPercent <= softDrainPercent)) return "soft";
  return "healthy";
}

export function accountIsDrained(row, softDrainPercent = SOFT_DRAIN_PERCENT, accountId = row?.id, options) {
  return leftoverHealth(row, softDrainPercent, accountId, options) === "drained";
}

export function accountIsAuthInvalid(row, accountId = row?.id, options) {
  return leftoverHealth(row, undefined, accountId, options) === "auth_invalid";
}

// The Fable family bucket (7d_oi) gates Fable models only. A spent family
// window keeps the account out of Fable turns and nothing else.
export function familyDrained(row, family, now = Date.now()) {
  if (family !== "fable") return false;
  const window = row?.fable;
  return windowIsLive(window, now) && window.remainingPercent <= DRAINED_LEFTOVER_PERCENT;
}

// The reset time an account is benched until after a shared quota rejection:
// the latest reset among the windows that signed it, since the account is
// usable again only once every one of them has rolled over.
export function claudeRejectionResetAt(unified, now = Date.now()) {
  const statuses = unified?.windowStatuses || {};
  const windows = [
    ["fiveHour", unified?.fiveHour],
    ["weekly", unified?.weekly],
  ];
  const signed = windows.filter(([key, window]) =>
    window && (statuses[key] === "rejected" ||
      (Number.isFinite(window.remainingPercent) && window.remainingPercent <= DRAINED_LEFTOVER_PERCENT)));
  const resets = (signed.length ? signed : windows)
    .map(([, window]) => Number(window?.resetsAtMs))
    .filter((ms) => Number.isFinite(ms) && ms > now);
  return resets.length ? Math.max(...resets) : undefined;
}

export function claudeModelFamily(model) {
  return /fable/i.test(String(model || "")) ? "fable" : undefined;
}

// The earliest future moment something in the pool becomes usable again: a
// drained window resetting or a cooldown ending. Never a time in the past.
export function nextClaudePoolResetAt(usageById, { now = Date.now(), accountIds } = {}) {
  const usage = usageById instanceof Map ? usageById : new Map(Object.entries(usageById || {}));
  const ids = accountIds ? [...accountIds] : [...new Set([...usage.keys(), ...cooldowns.keys()])];
  let earliest = null;
  const consider = (ms) => {
    if (Number.isFinite(ms) && ms > now && (earliest === null || ms < earliest)) earliest = ms;
  };
  for (const id of ids) {
    const row = usage.get(id);
    // An account is usable again only when every drained window has reset,
    // so its own recovery time is the latest of those resets.
    const drainedResets = [row?.fiveHour, row?.weekly]
      .filter((window) => windowIsLive(window, now) && window.remainingPercent <= DRAINED_LEFTOVER_PERCENT)
      .map((window) => Number(window.resetsAtMs))
      .filter((ms) => Number.isFinite(ms));
    if (drainedResets.length) consider(Math.max(...drainedResets));
    consider(cooldowns.get(id));
  }
  return earliest;
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
const familyCooldowns = new Map();
const affinities = new Map();
const authInvalidAccounts = new Map();

export function coolClaudeAccount(accountId, until) {
  if (!accountId || !Number.isFinite(until)) return;
  cooldowns.set(accountId, Math.max(cooldowns.get(accountId) || 0, until));
  forgetClaudeAccountAffinities(accountId);
}

export function claudeAccountCooldownUntil(accountId) {
  return cooldowns.get(accountId) || 0;
}

// A family-only rejection (Fable's 7d_oi bucket) benches the account for that
// family; every other model keeps using it.
export function coolClaudeAccountFamily(accountId, family, until) {
  if (!accountId || !family || !Number.isFinite(until)) return;
  const key = `${accountId}\u0000${family}`;
  familyCooldowns.set(key, Math.max(familyCooldowns.get(key) || 0, until));
}

export function claudeAccountFamilyCooldownUntil(accountId, family) {
  if (!accountId || !family) return 0;
  return familyCooldowns.get(`${accountId}\u0000${family}`) || 0;
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
  familyCooldowns.clear();
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
  tokenFingerprints,
  now = Date.now(),
} = {}) {
  const fingerprints = tokenFingerprints instanceof Map ? tokenFingerprints : new Map();
  const usage = usageById instanceof Map ? usageById : new Map(Object.entries(usageById || {}));
  const purposes = purposeById instanceof Map ? purposeById : new Map(Object.entries(purposeById || {}));
  const plans = planById instanceof Map ? planById : new Map(Object.entries(planById || {}));
  const orderIndex = new Map((order || []).map((id, index) => [id, index]));
  const pinIndex = new Map((pinOrder || DEFAULT_PIN_ORDER).map((purpose, index) => [purpose, index]));

  const quotaRank = (id) => {
    const health = leftoverHealth(usage.get(id), softDrainPercent, id, {
      now,
      tokenFingerprint: fingerprints.get(id),
    });
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
      const isAuthInv = isClaudeAccountAuthInvalid(entry.id, { tokenFingerprint: fingerprints.get(entry.id) });
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

// Whether an account's stored login can serve a turn right now or after an
// on-demand refresh. An expired access token is not a reason to drop the
// account: the attempt loop refreshes it, exactly as Claude Code itself does.
// Only a login with nothing to refresh from, or one the token endpoint has
// already refused (`reauth-required`), is out.
function routableSession(entry, { homesDir, now }) {
  const session = claudeOAuthSession(entry.id, { homesDir, now });
  if (!session) return undefined;
  const reauthRequired = entry?.health?.state === "reauth-required";
  if (session.accessToken && !session.expired) return session;
  if (session.refreshToken && !reauthRequired) return session;
  return undefined;
}

export function claudeRotationCandidates({
  conversationId,
  poolPath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  usageById,
  family,
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
  const tokenFingerprints = new Map();
  const candidates = [];
  const seenFingerprints = new Set();

  for (const entry of entries) {
    if (entry?.state !== "active" || entry?.paused) continue;
    const session = routableSession(entry, { homesDir, now });
    if (!session) continue;

    if (isClaudeAccountAuthInvalid(entry.id, { tokenFingerprint: session.tokenFingerprint })) continue;
    const cachedRow = usage.get(entry.id);
    if (cachedRow && rowAuthInvalid(cachedRow, session.tokenFingerprint)) continue;

    // Two registrations of one OAuth lineage are one quota.
    if (session.identityFingerprint && seenFingerprints.has(session.identityFingerprint)) continue;
    if (session.identityFingerprint) seenFingerprints.add(session.identityFingerprint);

    purposeById.set(entry.id, normalizePurpose(entry.purpose) || inferPurpose(entry.label, entry));
    planById.set(entry.id, entry.subscription?.plan);
    tokenFingerprints.set(entry.id, session.tokenFingerprint);

    candidates.push({
      id: entry.id,
      headers: session.headers,
      tokenFingerprint: session.tokenFingerprint,
      needsRefresh: Boolean(session.needsRefresh || session.expired || !session.accessToken),
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
    tokenFingerprints,
    now,
  });

  // Drain is derived availability rather than persisted state: a spent account
  // drops out now and is admitted again once its window resets or the next
  // healthy reading arrives, with no operator action. With no usage data at
  // all every session stays eligible -- rotating blindly beats refusing to.
  const eligible = ordered.filter((entry) => {
    const row = usage.get(entry.id);
    if (!row) return true;
    if (accountIsDrained(row, SOFT_DRAIN_PERCENT, entry.id, { now, tokenFingerprint: entry.tokenFingerprint })) {
      return false;
    }
    return !familyDrained(row, family, now);
  });
  const ready = eligible.filter((entry) =>
    (cooldowns.get(entry.id) || 0) <= now &&
    claudeAccountFamilyCooldownUntil(entry.id, family) <= now);
  // Falling back to `eligible` keeps a fully cooled-down pool usable: a stale
  // cooldown must not be the reason a request has no account at all.
  return ready.length ? ready : eligible;
}

export function claudePoolExhaustionReport({
  poolPath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  usageById,
  family,
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
  const unavailableIds = [];

  for (const entry of entries) {
    if (entry?.state !== "active" || entry?.paused) continue;
    totalActive++;
    const session = routableSession(entry, { homesDir, now });
    if (!session) {
      expired++;
      continue;
    }
    if (isClaudeAccountAuthInvalid(entry.id, { tokenFingerprint: session.tokenFingerprint })) {
      authInvalid++;
      continue;
    }
    const cachedRow = usage.get(entry.id);
    if (cachedRow && rowAuthInvalid(cachedRow, session.tokenFingerprint)) {
      authInvalid++;
      continue;
    }
    if (cachedRow && (
      accountIsDrained(cachedRow, SOFT_DRAIN_PERCENT, entry.id, { now, tokenFingerprint: session.tokenFingerprint }) ||
      familyDrained(cachedRow, family, now)
    )) {
      drained++;
      unavailableIds.push(entry.id);
      continue;
    }
    const isCooling = (cooldowns.get(entry.id) || 0) > now ||
      claudeAccountFamilyCooldownUntil(entry.id, family) > now;
    if (isCooling) {
      cooling++;
      unavailableIds.push(entry.id);
      continue;
    }
    const health = cachedRow
      ? leftoverHealth(cachedRow, SOFT_DRAIN_PERCENT, entry.id, { now, tokenFingerprint: session.tokenFingerprint })
      : "unknown";
    if (health === "soft") soft++;
    else healthy++;
  }

  if (healthy > 0 || soft > 0 || totalActive === 0) {
    return null;
  }

  let earliestResetMs = nextClaudePoolResetAt(usage, { now, accountIds: unavailableIds });
  if (family) {
    for (const id of unavailableIds) {
      const familyReset = [
        claudeAccountFamilyCooldownUntil(id, family),
        Number(usage.get(id)?.fable?.resetsAtMs),
      ].filter((ms) => Number.isFinite(ms) && ms > now);
      for (const ms of familyReset) {
        if (earliestResetMs === null || ms < earliestResetMs) earliestResetMs = ms;
      }
    }
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
