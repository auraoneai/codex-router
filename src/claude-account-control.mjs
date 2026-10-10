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
      const { fetchSectionData } = await import("./router-status-client.mjs");
      const served = await fetchSectionData("claude-usage");
      if (served !== undefined) {
        stdout.write(`${JSON.stringify(served)}\n`);
        return;
      }
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
          force: true,
        });
      } catch {
        snapshot = { accounts: [] };
      }
    }

    const { buildClaudeUsageReport } = await import("./pool-usage-report.mjs");
    const report = await buildClaudeUsageReport({ filePath, homesDir, usagePath, snapshot });
    stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  throw new Error(
    "Usage: control claude-account-pool status|add [label]|remove <acct_id>|select <acct_id>|enable <acct_id>|disable <acct_id>|usage [cached]",
  );
}
