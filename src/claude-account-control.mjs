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
import { importClaudeAccount } from "./claude-oauth-credentials.mjs";

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
    const snapshot = claudeSubscriptionAccountPoolSnapshot({ filePath, homesDir });
    let usage = {};
    try {
      usage = JSON.parse(readFileSync(usagePath, "utf8"));
    } catch {}

    const accountsWithUsage = {};
    for (const [id, account] of Object.entries(snapshot.accounts || {})) {
      const accountUsage = usage.accounts?.[id] || usage[id] || null;
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
      stdout.write(`${JSON.stringify({ account })}\n`);
    } catch (err) {
      throw new Error("No valid Claude Code credentials found. Please log into Claude Code with 'claude' first.", {
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
    if (value === "cached") {
      try {
        snapshot = JSON.parse(readFileSync(usagePath, "utf8"));
      } catch {
        snapshot = { accounts: [] };
      }
    } else {
      const { probeClaudeAccountUsage } = await import("./claude-usage-probe.mjs");
      snapshot = await probeClaudeAccountUsage({
        poolPath: filePath,
        homesDir,
        cachePath: usagePath,
      });
    }

    let poolState;
    try {
      poolState = readClaudeAccountPoolState(filePath);
    } catch {
      poolState = { accounts: {} };
    }

    const accounts = Array.isArray(snapshot?.accounts)
      ? snapshot.accounts
      : Object.entries(poolState.accounts || {}).map(([id, acc]) => ({
          id,
          label: acc.label,
        }));

    stdout.write(`${JSON.stringify({
      fetchedAt: snapshot?.fetchedAt || new Date().toISOString(),
      accounts,
    })}\n`);
    return;
  }

  throw new Error(
    "Usage: control claude-account-pool status|add [label]|remove <acct_id>|select <acct_id>|enable <acct_id>|disable <acct_id>|usage [cached]",
  );
}
