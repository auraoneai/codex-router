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

    const accountsWithUsage = {};
    for (const [id, account] of Object.entries(snapshot.accounts || {})) {
      const accountUsage = usageById.get(id) || usage.accounts?.[id] || usage[id] || null;
      accountsWithUsage[id] = {
        ...account,
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
    let snapshot;
    const isCachedOnly = value === "cached";
    if (isCachedOnly) {
      try {
        snapshot = JSON.parse(readFileSync(usagePath, "utf8"));
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
    const usableAccounts = poolAccounts.filter(
      (a) => a.subscription?.status === "usable" || a.subscription?.usable === true,
    );

    const usageList = Array.isArray(snapshot?.accounts)
      ? snapshot.accounts
      : snapshot?.accounts && typeof snapshot.accounts === "object"
        ? Object.values(snapshot.accounts)
        : [];
    let usageById = new Map(usageList.map((a) => [a?.id, a]).filter(([id]) => id));

    const cacheAgeMs = snapshot?.fetchedAt ? (Date.now() - new Date(snapshot.fetchedAt).getTime()) : Infinity;
    const hasMissingUsableAccount = usableAccounts.some((a) => !usageById.has(a.id));

    if (!isCachedOnly || hasMissingUsableAccount || (usableAccounts.length > 0 && cacheAgeMs > 300_000)) {
      try {
        const { probeClaudeAccountUsage } = await import("./claude-usage-probe.mjs");
        snapshot = await probeClaudeAccountUsage({
          poolPath: filePath,
          homesDir,
          cachePath: usagePath,
        });
        const freshList = Array.isArray(snapshot?.accounts)
          ? snapshot.accounts
          : snapshot?.accounts && typeof snapshot.accounts === "object"
            ? Object.values(snapshot.accounts)
            : [];
        usageById = new Map(freshList.map((a) => [a?.id, a]).filter(([id]) => id));
      } catch {}
    }

    const {
      claudeRotationCandidates,
      claudeAccountCooldownUntil,
      isClaudeAccountAuthInvalid,
    } = await import("./claude-account-rotation.mjs");

    const candidates = claudeRotationCandidates({
      poolPath: filePath,
      homesDir,
      usageById,
    });
    const order = candidates.map((c) => c.id);
    const now = Date.now();
    const accounts = poolAccounts.map((account) => {
      const cached = usageById.get(account.id);
      const fiveHour = cached?.fiveHour || account.usage?.fiveHour;
      const weekly = cached?.weekly || account.usage?.weekly;
      const primaryRemaining = fiveHour && Number.isFinite(fiveHour.remainingPercent)
        ? fiveHour.remainingPercent
        : null;
      const secondaryRemaining = weekly && Number.isFinite(weekly.remainingPercent)
        ? weekly.remainingPercent
        : null;

      const resetsAtMs = fiveHour?.resetsAtMs || weekly?.resetsAtMs || null;
      const resetsAtSec = resetsAtMs ? Math.floor(resetsAtMs / 1000) : null;

      const isAuthInvalid = account.health?.state === "reauth-required"
        || account.subscription?.status === "pending"
        || isClaudeAccountAuthInvalid(account.id);

      const cooldownUntil = claudeAccountCooldownUntil(account.id) || null;
      const isCooling = Boolean(cooldownUntil && cooldownUntil > now);

      let health = "healthy";
      if (isAuthInvalid) {
        health = "unknown";
      } else if (isCooling) {
        health = "soft";
      } else if (account.health?.state === "drained" || (primaryRemaining !== null && primaryRemaining <= 0)) {
        health = "drained";
      } else if (primaryRemaining !== null && primaryRemaining <= 15) {
        health = "soft";
      }

      return {
        id: account.id,
        label: account.identity?.email || account.label || "Claude account",
        preferred: poolState.policy?.selectedAccountId === account.id,
        planType: account.tier || account.identity?.subscriptionType || "pro",
        health,
        cooling: isCooling,
        cooldownUntil,
        primaryRemainingPercent: primaryRemaining,
        secondaryRemainingPercent: secondaryRemaining,
        resetsAt: resetsAtSec,
        authInvalid: isAuthInvalid,
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
