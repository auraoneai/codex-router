// Report builders shared by `control` and the router's status-snapshot
// endpoint. The tray and per-turn probes poll these surfaces constantly, and
// every poll used to boot a node process to recompute them; the router serves
// the same bytes from its long-lived process instead. The builders are pure
// projections over their inputs (plus rotation state), so both paths agree
// byte for byte. One deliberate exception: the cooling fields read the
// process's live cooldown maps, so the router answers with true live values
// while a spawned `control` always saw empty ones.
import { readFileSync } from "node:fs";

import { discoveryDisabled } from "./discovery-mode.mjs";
import {
  CHATGPT_ACCOUNT_USAGE_CACHE_PATH,
  CLAUDE_ACCOUNT_USAGE_CACHE_PATH,
} from "./paths.mjs";

export function readUsageSnapshotFile(cachePath) {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return { accounts: [] };
  }
}

// Moved verbatim from printAccountUsage in control.mjs: the selected profile's
// live quota plus the selection the tray renders beside it.
export async function buildAccountUsageReport() {
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT account profiles are unavailable while credential discovery is disabled.",
    );
  }
  const { readCodexAccountUsage } = await import("./codex-account-usage.mjs");
  const {
    ensureChatGPTProfileAccounts,
    selectedChatGPTUsageProfile,
  } = await import("./chatgpt-profile-switch.mjs");
  await ensureChatGPTProfileAccounts();
  const profile = selectedChatGPTUsageProfile();
  const usage = profile.home
    ? await readCodexAccountUsage({ codexHome: profile.home })
    : await readCodexAccountUsage();
  return {
    ...usage,
    accountSelection: profile.selection,
    accountEmail: profile.email || null,
    profilePending: profile.pending === true,
  };
}

// Moved verbatim from the chatgpt-account-pool usage action in control.mjs:
// ranks the snapshot the way rotation does and projects one row per account.
export async function buildChatGPTUsageReport(snapshot, { poolState, now = Date.now() } = {}) {
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT account profiles are unavailable while credential discovery is disabled.",
    );
  }
  const {
    rotationCandidates,
    leftoverHealth,
    accountCooldownUntil,
    accountSpendsCredits,
  } = await import("./chatgpt-rotation.mjs");
  const { chatGPTSubscriptionAccountResetAttemptPending } = await import(
    "./chatgpt-account-pool.mjs"
  );
  const usageById = new Map((snapshot?.accounts || []).map((entry) => [entry.id, entry]));
  const order = rotationCandidates({ usageById }).map((entry) => entry.id);
  let resolvedPoolState = poolState;
  if (!resolvedPoolState) {
    const { readChatGPTAccountPoolState } = await import("./chatgpt-account-pool.mjs");
    try {
      resolvedPoolState = readChatGPTAccountPoolState();
    } catch {
      resolvedPoolState = { accounts: {} };
    }
  }
  return {
    fetchedAt: snapshot?.fetchedAt,
    rotation: order,
    accounts: (snapshot?.accounts || []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      preferred: entry.preferred,
      planType: entry.planType,
      health: leftoverHealth(entry),
      cooling: (accountCooldownUntil(entry.id) || 0) > now,
      cooldownUntil: accountCooldownUntil(entry.id) || null,
      primaryRemainingPercent: entry.primary?.remainingPercent ?? null,
      secondaryRemainingPercent: entry.secondary?.remainingPercent ?? null,
      resetCredits: entry.resetCredits ?? null,
      credits: entry.credits ?? null,
      creditFallback: resolvedPoolState.accounts?.[entry.id]?.creditFallback === true,
      spendingCredits: accountSpendsCredits(resolvedPoolState.accounts?.[entry.id], entry, now),
      resetAttemptPending: chatGPTSubscriptionAccountResetAttemptPending(entry.id, {
        state: resolvedPoolState,
      }),
      resetsAt: entry.secondary?.resetsAt ?? entry.primary?.resetsAt ?? null,
      ...(entry.authInvalid
        ? { authInvalid: true, authErrorCode: entry.authErrorCode || "token_revoked" }
        : {}),
      ...(entry.error ? { error: entry.error } : {}),
    })),
  };
}

export function chatGPTUsageSnapshotPath() {
  return CHATGPT_ACCOUNT_USAGE_CACHE_PATH;
}

// Moved verbatim from the claude-account-pool usage action in
// claude-account-control.mjs. Cached semantics only: reads the snapshot file
// the forwarder's probe schedule keeps fresh and never reaches the network,
// because the tray calls it on every state-directory change.
export async function buildClaudeUsageReport({
  filePath,
  homesDir,
  usagePath = CLAUDE_ACCOUNT_USAGE_CACHE_PATH,
  snapshot,
  now = Date.now(),
} = {}) {
  if (discoveryDisabled()) {
    throw new Error(
      "Claude account profiles are unavailable while credential discovery is disabled.",
    );
  }
  let resolved = snapshot;
  if (resolved === undefined) {
    try {
      resolved = JSON.parse(readFileSync(usagePath, "utf8"));
    } catch {
      resolved = { accounts: [] };
    }
  }
  const { readClaudeAccountPoolState } = await import("./claude-account-pool.mjs");
  let poolState;
  try {
    poolState = readClaudeAccountPoolState(filePath);
  } catch {
    poolState = { accounts: {} };
  }
  const poolAccounts = Object.values(poolState.accounts || {}).filter(
    (a) => a && a.state !== "revoked",
  );

  const usageList = Array.isArray(resolved?.accounts)
    ? resolved.accounts
    : resolved?.accounts && typeof resolved.accounts === "object"
      ? Object.values(resolved.accounts)
      : [];
  const rawUsageById = new Map(usageList.map((a) => [a?.id, a]).filter(([id]) => id));

  const { claudeOAuthSession } = await import("./claude-oauth-session.mjs");
  const {
    claudeSeatTier,
    claudeRotationCandidates,
    claudeAccountCooldownUntil,
    isClaudeAccountAuthInvalid,
    leftoverHealth,
    windowIsLive,
  } = await import("./claude-account-rotation.mjs");
  const {
    cachedClaudeAccountUsageById,
    claudeUsageRowObservedAtMs,
    USAGE_CACHE_MAX_AGE_MS,
  } = await import("./claude-account-usage.mjs");

  // Rank on exactly what the forwarder ranks on: the same file, read through
  // the same per-row freshness rules.
  const usageById = cachedClaudeAccountUsageById({ usagePath, force: true });
  const order = claudeRotationCandidates({
    poolPath: filePath,
    homesDir,
    usageById,
  }).map((c) => c.id);

  // A window whose reset has passed reports nothing: its old figure would
  // show a refilled account as 0% until the next reading arrives.
  const liveRemaining = (window) => (windowIsLive(window, now) ? window.remainingPercent : null);
  const windowResetSec = (window) => {
    const ms = Number(window?.resetsAtMs);
    return windowIsLive(window, now) && Number.isFinite(ms) && ms > now ? Math.floor(ms / 1000) : null;
  };
  const accounts = poolAccounts.map((account) => {
    const row = rawUsageById.get(account.id) || null;
    const fiveHour = row?.fiveHour;
    const weekly = row?.weekly;
    const primaryRemaining = liveRemaining(fiveHour);
    const secondaryRemaining = liveRemaining(weekly);

    // The reset that matters is the one of the tighter live window.
    const live = [fiveHour, weekly].filter((window) => windowIsLive(window, now));
    const binding = live.sort((left, right) => left.remainingPercent - right.remainingPercent)[0];
    const resetsAtMs = Number(binding?.resetsAtMs);
    const resetsAtSec =
      Number.isFinite(resetsAtMs) && resetsAtMs > now ? Math.floor(resetsAtMs / 1000) : null;

    const verdict = row ? leftoverHealth(row, undefined, account.id, { now }) : "unknown";
    const isAuthInvalid = account.health?.state === "reauth-required"
      || verdict === "auth_invalid"
      || isClaudeAccountAuthInvalid(account.id);
    const health = isAuthInvalid || !["healthy", "soft", "drained"].includes(verdict)
      ? "unknown"
      : verdict;

    const cooldownUntil = claudeAccountCooldownUntil(account.id) || null;
    const isCooling = Boolean(cooldownUntil && cooldownUntil > now);

    return {
      id: account.id,
      label: account.identity?.email || account.label || "Claude account",
      preferred: poolState.policy?.selectedAccountId === account.id,
      // Standard vs Premium (5x) for a Team seat, read from the login itself.
      planType:
        claudeSeatTier(claudeOAuthSession(account.id, { homesDir }) || {})?.label ||
        account.subscription?.plan ||
        row?.plan ||
        account.identity?.subscriptionType ||
        null,
      health,
      cooling: isCooling,
      cooldownUntil,
      primaryRemainingPercent: primaryRemaining,
      secondaryRemainingPercent: secondaryRemaining,
      resetsAt: resetsAtSec,
      // Each window's own reset, so the island labels a countdown with the
      // window it belongs to rather than the binding one.
      primaryResetsAt: windowResetSec(fiveHour),
      secondaryResetsAt: windowResetSec(weekly),
      authInvalid: isAuthInvalid,
      ...(isAuthInvalid ? { authErrorCode: row?.authErrorCode || "token_revoked" } : {}),
      ...(account.state !== "active" || account.paused ? { paused: true } : {}),
      ...(row?.error ? { error: row.error } : {}),
      ...(row?.error ? probeFailureDetail(row) : {}),
    };
  });

  // A failed probe keeps the last reading, so the error alone does not say
  // whether the figures on the row are still worth trusting. Judge them by the
  // row's own reading time -- never the document's, which every probe round
  // bumps -- under the freshness bound rotation applies.
  function probeFailureDetail(row) {
    const readAtMs = claudeUsageRowObservedAtMs(row, undefined);
    const readingStale = !Number.isFinite(readAtMs) || now - readAtMs > USAGE_CACHE_MAX_AGE_MS;
    return {
      readingStale,
      ...(Number.isFinite(readAtMs) ? { readingAt: Math.floor(readAtMs / 1000) } : {}),
      ...(row.rateLimited ? { rateLimited: true } : {}),
    };
  }

  return {
    fetchedAt: resolved?.fetchedAt || new Date().toISOString(),
    rotation: order,
    accounts,
  };
}

export function claudeUsageSnapshotPath() {
  return CLAUDE_ACCOUNT_USAGE_CACHE_PATH;
}
