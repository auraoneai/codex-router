// Persists per-account ChatGPT quota so rotation can rank accounts.
//
// Upstream already probes usage: `attachBoundedChatGPTAccountUsage` spawns the
// Codex app-server per account, bounded and in parallel, and annotates the pool
// it was handed. But it annotates an in-memory object and returns, so nothing on
// disk survives the call, and a request path must never spawn an app-server to
// find out whether an account has room.
//
// This writes the snapshot that `chatgpt-rotation.mjs` reads. The two windows
// are kept under upstream's own `primary`/`secondary` names rather than the old
// `fiveHour`/`weekly` spelling, because the rotation reader accepts both and the
// upstream names are the ones that will keep matching future releases.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CHATGPT_ACCOUNT_HOMES_DIR,
  CHATGPT_ACCOUNT_POOL_PATH,
  CHATGPT_ACCOUNT_USAGE_CACHE_PATH,
  CHATGPT_PROFILE_SWITCH_PATH,
  CODEX_HOME,
} from "./paths.mjs";
import { readChatGPTAccountPoolState } from "./chatgpt-account-pool.mjs";
import {
  BACKGROUND_USAGE_MIN_ACCESS_LIFETIME_MS,
  readCodexAccountUsage,
} from "./codex-account-usage.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { clearAccountAuthInvalid } from "./chatgpt-rotation.mjs";

export const USAGE_PROBE_TIMEOUT_MS = 12_000;
export const USAGE_PROBE_LIMIT = 8;

function accountHome(accountId, homesDir) {
  return path.join(homesDir, accountId);
}

function writeAtomicPrivateJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp.${path.basename(filePath)}.${process.pid}.${Date.now()}`);
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  protectPrivateFile(tmpPath);
  renameSync(tmpPath, filePath);
  protectPrivateFile(filePath);
}

export function nextKnownResetAt(accounts, { now = Date.now() } = {}) {
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
      acct?.secondary?.resetsAt,
      acct?.primary?.resetsAt,
      acct?.fiveHour?.resetsAt,
      acct?.weekly?.resetsAt,
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

// Probes every usable account and writes the snapshot. Returns the snapshot so a
// caller can report it without reading the file back.
//
// A probe failure for one account is recorded as an absent reading rather than
// omitted: rotation treats "no numbers" as eligible, so a transient app-server
// failure must not silently look like a healthy account.
async function executeProbeChatGPTAccountUsage({
  poolPath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  cachePath = CHATGPT_ACCOUNT_USAGE_CACHE_PATH,
  readUsage = readCodexAccountUsage,
  timeoutMs = USAGE_PROBE_TIMEOUT_MS,
  probeLimit = USAGE_PROBE_LIMIT,
  now = Date.now(),
  write = true,
  primaryHome = CODEX_HOME,
  switchPath = CHATGPT_PROFILE_SWITCH_PATH,
} = {}) {
  let pool;
  try {
    pool = readChatGPTAccountPoolState(poolPath);
  } catch {
    return { fetchedAt: new Date(now).toISOString(), accounts: [] };
  }
  const selectedId = pool?.policy?.selectedAccountId;
  // The selected account's saved profile is a snapshot of the desktop's live
  // auth. A second app-server on that snapshot can refresh the same rotating
  // token independently and leave one of the two credential stores stale.
  const { selectedChatGPTUsageProfile } = await import("./chatgpt-profile-switch.mjs");
  const selectedProfile = selectedChatGPTUsageProfile({
    filePath: poolPath, homesDir, primaryHome, switchPath,
  });
  const candidates = Object.values(pool?.accounts || {})
    .filter((account) => account?.state === "active" && !account?.paused)
    // The switched-in account is probed first so a truncated run still knows
    // about the one currently spending the operator's quota.
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

  const accounts = await Promise.all(candidates.map(async (account) => {
    const base = {
      id: account.id,
      label: account.label || "",
      state: account.state,
      preferred: account.id === selectedId,
    };
    const prev = prevAccountsById.get(account.id);
    try {
      const codexHome = account.id === selectedProfile.selection && selectedProfile.home
        ? selectedProfile.home
        : accountHome(account.id, homesDir);
      const usage = await readUsage({
        codexHome, timeoutMs,
        minAccessLifetimeMs: BACKGROUND_USAGE_MIN_ACCESS_LIFETIME_MS,
      });
      const isAuthInvalid = usage?.authInvalid === true ||
        Boolean(usage?.rateLimitError && /401|token_revoked|invalidated oauth token|invalid_token|unauthorized/i.test(usage.rateLimitError));
      if (!isAuthInvalid) {
        clearAccountAuthInvalid(account.id);
      }
      return {
        ...base,
        planType: usage.planType ?? (!isAuthInvalid && !prev?.authInvalid ? prev?.planType ?? null : null),
        primary: usage.primary ?? null,
        secondary: usage.secondary ?? null,
        resetCredits: usage.resetCredits ?? null,
        fetchedAt: usage.fetchedAt,
        ...(isAuthInvalid ? { authInvalid: true, authErrorCode: usage.authErrorCode || "token_revoked" } : {}),
        ...(usage?.rateLimitError ? { error: usage.rateLimitError } : {}),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Usage unavailable.";
      const isAuthInvalid = /401|token_revoked|invalidated oauth token|invalid_token|unauthorized/i.test(msg);
      return {
        ...base,
        // A transient probe outage must not erase a previously verified plan
        // tier: rotation uses it to spend Plus quota before Pro quota. An
        // authentication failure invalidates that identity and its tier.
        planType: !isAuthInvalid && !prev?.authInvalid ? prev?.planType ?? null : null,
        primary: !isAuthInvalid && prev?.primary ? prev.primary : null,
        secondary: !isAuthInvalid && prev?.secondary ? prev.secondary : null,
        resetCredits: null,
        error: msg,
        ...(isAuthInvalid ? { authInvalid: true, authErrorCode: "token_revoked" } : {}),
      };
    }
  }));
  const snapshot = { version: 1, fetchedAt: new Date(now).toISOString(), accounts };
  if (write) {
    try {
      // The snapshot names accounts and their remaining quota, which is
      // operator metadata rather than a credential, but it lives beside the
      // credential store and is held to the same bound.
      writeAtomicPrivateJson(cachePath, snapshot);
    } catch {
      // A snapshot that cannot be written degrades rotation to order-only
      // ranking; it must not fail the caller that asked for a probe.
    }
  }
  return snapshot;
}

const inFlightProbes = new Map();

export async function probeChatGPTAccountUsage(options = {}) {
  const key = options.cachePath || CHATGPT_ACCOUNT_USAGE_CACHE_PATH;
  if (inFlightProbes.has(key)) {
    if (!options.freshAfterInFlight) return inFlightProbes.get(key);
    // A reset needs a post-redemption read. Joining a poll that began before
    // the consume request could report the old quota and credit count.
    await inFlightProbes.get(key).catch(() => {});
  }
  const promise = executeProbeChatGPTAccountUsage(options).finally(() => {
    inFlightProbes.delete(key);
  });
  inFlightProbes.set(key, promise);
  return promise;
}
