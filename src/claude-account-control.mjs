import { readFileSync } from "node:fs";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { CLAUDE_ACCOUNT_USAGE_CACHE_PATH } from "./paths.mjs";
import {
  claudeSubscriptionAccountPoolSnapshot,
  isClaudeAccountId,
  readClaudeAccountPoolState,
  removeClaudeSubscriptionAccount,
  sanitizeClaudeAccount,
  withClaudeAccountPoolLock,
  writeClaudeAccountPoolState,
} from "./claude-account-pool.mjs";
import { importClaudeAccount, reconcileClaudeCliCredentials } from "./claude-oauth-credentials.mjs";

export async function handleClaudeAccountPool(action, value, {
  stdout = process.stdout,
  filePath,
  homesDir,
  usagePath = CLAUDE_ACCOUNT_USAGE_CACHE_PATH,
} = {}) {
  if (discoveryDisabled()) {
    throw new Error(
      "Claude account profiles are unavailable while credential discovery is disabled.",
    );
  }

  if (!action || action === "status") {
    try {
      await reconcileClaudeCliCredentials({ filePath, homesDir });
    } catch {}

    const snapshot = claudeSubscriptionAccountPoolSnapshot({ filePath, homesDir });
    let usage = {};
    try {
      usage = JSON.parse(readFileSync(usagePath, "utf8"));
    } catch {}

    const usageList = Array.isArray(usage.accounts)
      ? usage.accounts
      : usage.accounts && typeof usage.accounts === "object"
        ? Object.values(usage.accounts)
        : [];
    let usageById = new Map(usageList.map((a) => [a?.id, a]).filter(([id]) => id));

    const activeUsableAccounts = Object.values(snapshot.accounts || {}).filter(
      (a) => a?.state === "active" && (a?.subscription?.status === "usable" || a?.subscription?.usable === true),
    );
    const hasMissingUsage = activeUsableAccounts.some((a) => !usageById.has(a.id));
    if (hasMissingUsage && activeUsableAccounts.length > 0) {
      try {
        const { probeClaudeAccountUsage } = await import("./claude-usage-probe.mjs");
        const probed = await probeClaudeAccountUsage({
          poolPath: filePath,
          homesDir,
          cachePath: usagePath,
        });
        const freshList = Array.isArray(probed?.accounts)
          ? probed.accounts
          : probed?.accounts && typeof probed.accounts === "object"
            ? Object.values(probed.accounts)
            : [];
        usageById = new Map(freshList.map((a) => [a?.id, a]).filter(([id]) => id));
      } catch {}
    }

    const { claudeSeatTier } = await import("./claude-account-rotation.mjs");
    const { claudeOAuthSession } = await import("./claude-oauth-session.mjs");
    const accountsWithUsage = {};
    for (const [id, account] of Object.entries(snapshot.accounts || {})) {
      const accountUsage = usageById.get(id) || usage.accounts?.[id] || usage[id] || null;
      const seat = claudeSeatTier(claudeOAuthSession(id, { homesDir }) || {});
      accountsWithUsage[id] = {
        ...account,
        ...(seat ? { tier: seat.label } : {}),
        ...(accountUsage ? { usage: accountUsage } : {}),
      };
    }

    stdout.write(`${JSON.stringify({
      ...snapshot,
      accounts: accountsWithUsage,
    })}\n`);
    return;
  }

  if (action === "add") {
    try {
      const account = await importClaudeAccount(value, { filePath, homesDir });
      if (account?.subscription?.status === "usable") {
        try {
          const { probeClaudeAccountUsage } = await import("./claude-usage-probe.mjs");
          await probeClaudeAccountUsage({ poolPath: filePath, homesDir, cachePath: usagePath });
        } catch {}
      }
      stdout.write(`${JSON.stringify({ account })}\n`);
    } catch (err) {
      throw new Error(err?.message || "No valid Claude Code credentials found. Please log into Claude Code with 'claude' first.", {
        cause: err,
      });
    }
    return;
  }

  if (action === "remove") {
    const id = String(value || "").trim();
    if (!isClaudeAccountId(id)) {
      throw new Error("Select a registered Claude account id.");
    }
    const removed = await withClaudeAccountPoolLock(
      () => removeClaudeSubscriptionAccount(id, { filePath, homesDir }),
      { filePath },
    );
    stdout.write(`${JSON.stringify({ account: removed })}\n`);
    return;
  }

  if (action === "select") {
    const id = String(value || "").trim();
    if (!isClaudeAccountId(id)) {
      throw new Error("Select a registered Claude account id.");
    }
    const updated = await withClaudeAccountPoolLock(async () => {
      const state = readClaudeAccountPoolState(filePath);
      const account = state.accounts?.[id];
      if (!account || account.state === "revoked") {
        throw new Error("Select a registered Claude account id.");
      }
      state.policy.selectedAccountId = id;
      writeClaudeAccountPoolState(state, filePath);
      return state;
    }, { filePath });
    stdout.write(`${JSON.stringify({ policy: updated.policy })}\n`);
    return;
  }

  if (action === "enable") {
    const id = String(value || "").trim();
    if (!isClaudeAccountId(id)) {
      throw new Error("Select a registered Claude account id.");
    }
    const updated = await withClaudeAccountPoolLock(async () => {
      const state = readClaudeAccountPoolState(filePath);
      const account = state.accounts?.[id];
      if (!account || account.state === "revoked") {
        throw new Error("Select a registered Claude account id.");
      }
      account.paused = false;
      writeClaudeAccountPoolState(state, filePath);
      return sanitizeClaudeAccount(account);
    }, { filePath });
    stdout.write(`${JSON.stringify({ account: updated })}\n`);
    return;
  }

  if (action === "disable") {
    const id = String(value || "").trim();
    if (!isClaudeAccountId(id)) {
      throw new Error("Select a registered Claude account id.");
    }
    const updated = await withClaudeAccountPoolLock(async () => {
      const state = readClaudeAccountPoolState(filePath);
      const account = state.accounts?.[id];
      if (!account || account.state === "revoked") {
        throw new Error("Select a registered Claude account id.");
      }
      account.paused = true;
      writeClaudeAccountPoolState(state, filePath);
      return sanitizeClaudeAccount(account);
    }, { filePath });
    stdout.write(`${JSON.stringify({ account: updated })}\n`);
    return;
  }

  if (action === "usage") {
    // `cached` reports what rotation is deciding on right now without spending
    // a probe -- the tray calls it on every state-directory change, so it must
    // never reach the network or refresh a token. The bare form probes first.
    // The forwarder's own probe schedule is what keeps the cached file fresh.
    let snapshot;
    if (value === "cached") {
      try {
        snapshot = JSON.parse(readFileSync(usagePath, "utf8"));
      } catch {
        snapshot = { accounts: [] };
      }
    } else {
      const { probeClaudeAccountUsage } = await import("./claude-usage-probe.mjs");
      try {
        snapshot = await probeClaudeAccountUsage({
          poolPath: filePath,
          homesDir,
          cachePath: usagePath,
        });
      } catch {
        snapshot = { accounts: [] };
      }
    }

    let poolState;
    try {
      poolState = readClaudeAccountPoolState(filePath);
    } catch {
      poolState = { accounts: {} };
    }
    const poolAccounts = Object.values(poolState.accounts || {}).filter(
      (a) => a && a.state !== "revoked",
    );

    const usageList = Array.isArray(snapshot?.accounts)
      ? snapshot.accounts
      : snapshot?.accounts && typeof snapshot.accounts === "object"
        ? Object.values(snapshot.accounts)
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
    const { cachedClaudeAccountUsageById } = await import("./claude-account-usage.mjs");

    // Rank on exactly what the forwarder ranks on: the same file, read through
    // the same per-row freshness rules.
    const usageById = cachedClaudeAccountUsageById({ usagePath, force: true });
    const order = claudeRotationCandidates({
      poolPath: filePath,
      homesDir,
      usageById,
    }).map((c) => c.id);
    const now = Date.now();

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
      const resetsAtSec = Number.isFinite(resetsAtMs) && resetsAtMs > now ? Math.floor(resetsAtMs / 1000) : null;

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
        planType: claudeSeatTier(claudeOAuthSession(account.id, { homesDir }) || {})?.label
          || account.subscription?.plan || row?.plan || account.identity?.subscriptionType || null,
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
      };
    });

    stdout.write(`${JSON.stringify({
      fetchedAt: snapshot?.fetchedAt || new Date().toISOString(),
      rotation: order,
      accounts,
    })}\n`);
    return;
  }

  throw new Error(
    "Usage: control claude-account-pool status|add [label]|remove <acct_id>|select <acct_id>|enable <acct_id>|disable <acct_id>|usage [cached]",
  );
}
