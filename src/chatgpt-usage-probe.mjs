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

import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  CHATGPT_ACCOUNT_HOMES_DIR,
  CHATGPT_ACCOUNT_POOL_PATH,
  CHATGPT_ACCOUNT_USAGE_CACHE_PATH,
} from "./paths.mjs";
import { readChatGPTAccountPoolState } from "./chatgpt-account-pool.mjs";
import { readCodexAccountUsage } from "./codex-account-usage.mjs";
import { protectPrivateFile } from "./file-security.mjs";

export const USAGE_PROBE_TIMEOUT_MS = 12_000;
export const USAGE_PROBE_LIMIT = 8;

function accountHome(accountId, homesDir) {
  return path.join(homesDir, accountId);
}

// Probes every usable account and writes the snapshot. Returns the snapshot so a
// caller can report it without reading the file back.
//
// A probe failure for one account is recorded as an absent reading rather than
// omitted: rotation treats "no numbers" as eligible, so a transient app-server
// failure must not silently look like a healthy account.
export async function probeChatGPTAccountUsage({
  poolPath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  cachePath = CHATGPT_ACCOUNT_USAGE_CACHE_PATH,
  readUsage = readCodexAccountUsage,
  timeoutMs = USAGE_PROBE_TIMEOUT_MS,
  probeLimit = USAGE_PROBE_LIMIT,
  now = Date.now(),
  write = true,
} = {}) {
  let pool;
  try {
    pool = readChatGPTAccountPoolState(poolPath);
  } catch {
    return { fetchedAt: new Date(now).toISOString(), accounts: [] };
  }
  const selectedId = pool?.policy?.selectedAccountId;
  const candidates = Object.values(pool?.accounts || {})
    .filter((account) => account?.state === "active" && !account?.paused)
    // The switched-in account is probed first so a truncated run still knows
    // about the one currently spending the operator's quota.
    .sort((left, right) => Number(right.id === selectedId) - Number(left.id === selectedId))
    .slice(0, Math.max(0, Math.floor(probeLimit)));
  const accounts = await Promise.all(candidates.map(async (account) => {
    const base = {
      id: account.id,
      label: account.label || "",
      state: account.state,
      preferred: account.id === selectedId,
    };
    try {
      const usage = await readUsage({ codexHome: accountHome(account.id, homesDir), timeoutMs });
      return {
        ...base,
        planType: usage.planType ?? null,
        primary: usage.primary ?? null,
        secondary: usage.secondary ?? null,
        fetchedAt: usage.fetchedAt,
      };
    } catch (error) {
      return {
        ...base,
        planType: null,
        primary: null,
        secondary: null,
        error: error instanceof Error ? error.message : "Usage unavailable.",
      };
    }
  }));
  const snapshot = { version: 1, fetchedAt: new Date(now).toISOString(), accounts };
  if (write) {
    try {
      // The snapshot names accounts and their remaining quota, which is
      // operator metadata rather than a credential, but it lives beside the
      // credential store and is held to the same bound.
      writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      protectPrivateFile(cachePath);
    } catch {
      // A snapshot that cannot be written degrades rotation to order-only
      // ranking; it must not fail the caller that asked for a probe.
    }
  }
  return snapshot;
}
