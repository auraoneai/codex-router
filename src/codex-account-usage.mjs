import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { findCodexBinary } from "./codex-binary.mjs";
import { tokenExpiryMs } from "./codex-native-session.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
export const ACCOUNT_POOL_USAGE_PROBE_LIMIT = 8;
export const ACCOUNT_POOL_USAGE_TIMEOUT_MS = 2_000;
export const BACKGROUND_USAGE_MIN_ACCESS_LIFETIME_MS = 10 * 60_000;

// This used to keep its own two-line search -- an undocumented CODEX_BINARY
// override, a hardcoded macOS app path, then the bare name "codex". None of
// the three finds a Windows install: the bundled Desktop CLI lives under a
// version-hashed %LOCALAPPDATA% directory, and a bare "codex" resolves to the
// extensionless npm shim that Node cannot spawn. The panel reported "the Codex
// app-server could not be started" on every Windows machine. Use the same
// discovery the rest of the router uses, and keep CODEX_BINARY working for
// anyone who set it.
function codexBinary() {
  return process.env.CODEX_BINARY || findCodexBinary();
}

// Killing a child that was reached through cmd.exe kills the shell, not the
// app-server behind it. On a timeout that left a Codex process holding the
// pipe for as long as the session lived, once per poll.
function killProcessTree(child, viaShell) {
  if (!viaShell || process.platform !== "win32" || !child.pid) {
    child.kill();
    return;
  }
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    child.kill();
  }
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = clampPercent(window.usedPercent);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: Number.isFinite(window.windowDurationMins)
      ? window.windowDurationMins
      : null,
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
  };
}

function optionalTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
}

function normalizeResetCredits(response) {
  const raw = response?.rateLimitResetCredits;
  if (!raw || typeof raw !== "object") return null;
  const count = raw.availableCount;
  if (!Number.isSafeInteger(count) || count < 0) return null;
  // Credit details can be truncated and contain backend display text. The
  // snapshot only needs the redeemable count; the backend selects a credit.
  return { availableCount: count };
}

export function normalizeCodexAccountUsage(rateLimitResponse, usageResponse, now = new Date()) {
  const buckets = Array.isArray(usageResponse?.dailyUsageBuckets)
    ? usageResponse.dailyUsageBuckets
        .filter(
          (bucket) =>
            typeof bucket?.startDate === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate) &&
            Number.isFinite(bucket.tokens),
        )
        .map((bucket) => ({
          startDate: bucket.startDate,
          tokens: Math.max(0, Math.trunc(bucket.tokens)),
          ...(optionalTokenCount(bucket.inputTokens) !== undefined
            ? { inputTokens: optionalTokenCount(bucket.inputTokens) }
            : {}),
          ...(optionalTokenCount(bucket.cachedInputTokens) !== undefined
            ? { cachedInputTokens: optionalTokenCount(bucket.cachedInputTokens) }
            : {}),
          ...(optionalTokenCount(bucket.outputTokens) !== undefined
            ? { outputTokens: optionalTokenCount(bucket.outputTokens) }
            : {}),
        }))
        .sort((left, right) => left.startDate.localeCompare(right.startDate))
    : [];
  const limits = rateLimitResponse?.rateLimits || {};
  const summary = usageResponse?.summary || {};
  const rateLimitError = rateLimitResponse?.error;
  const rateLimitErrorMsg = typeof rateLimitError === "string"
    ? rateLimitError
    : rateLimitError?.message || (rateLimitError ? JSON.stringify(rateLimitError) : "");
  const isAuthInvalid = Boolean(
    rateLimitError &&
    /401|token_revoked|invalidated oauth token|invalid_token|unauthorized/i.test(rateLimitErrorMsg),
  );
  return {
    fetchedAt: now.toISOString(),
    planType: typeof limits.planType === "string" ? limits.planType : null,
    limitId: typeof limits.limitId === "string" ? limits.limitId : null,
    primary: normalizeWindow(limits.primary),
    secondary: normalizeWindow(limits.secondary),
    resetCredits: normalizeResetCredits(rateLimitResponse),
    dailyUsageBuckets: buckets,
    summary: {
      lifetimeTokens: Number.isFinite(summary.lifetimeTokens) ? summary.lifetimeTokens : null,
      peakDailyTokens: Number.isFinite(summary.peakDailyTokens) ? summary.peakDailyTokens : null,
      currentStreakDays: Number.isFinite(summary.currentStreakDays)
        ? summary.currentStreakDays
        : null,
    },
    ...(rateLimitErrorMsg ? { rateLimitError: rateLimitErrorMsg } : {}),
    ...(isAuthInvalid ? { authInvalid: true, authErrorCode: "token_revoked" } : {}),
  };
}

// A redemption is bound to the isolated profile in two independent responses
// before the one-way consume request is sent. account/read has an email but no
// account id; rateLimits/read has an account id but no email. Both must agree
// with the registered identity, rather than trusting CODEX_HOME alone.
export function consumeCodexRateLimitResetCredit({
  expectedAccountId,
  expectedEmail,
  idempotencyKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  binary = codexBinary(),
  platform = process.platform,
  codexHome,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    if (discoveryDisabled()) {
      reject(new Error("Credential discovery is disabled (--no-discovery); the Codex account is not read."));
      return;
    }
    if (!binary) {
      reject(new Error("The Codex app-server could not be started: no Codex binary was found."));
      return;
    }
    if (!codexHome || !expectedAccountId || !expectedEmail || !/^[0-9a-f-]{36}$/i.test(idempotencyKey || "")) {
      reject(new Error("A registered account identity and reset attempt are required."));
      return;
    }
    const target = spawnableCommand(binary, ["app-server"], platform);
    let child;
    try { child = spawnImpl(target.command, target.args, {
      ...target.options,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }); } catch {
      const error = new Error("The Codex app-server could not be started.");
      error.resetRequestSent = false;
      reject(error);
      return;
    }
    let lines;
    try { lines = readline.createInterface({ input: child.stdout }); } catch {
      killProcessTree(child, Boolean(target.options.windowsVerbatimArguments));
      const error = new Error("The Codex app-server could not be started.");
      error.resetRequestSent = false;
      reject(error);
      return;
    }
    let settled = false;
    let account;
    let limits;
    let consumeSent = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killProcessTree(child, Boolean(target.options.windowsVerbatimArguments));
      if (error) {
        // The pool may discard a fresh attempt only when no consume request
        // reached the app-server. All post-send failures retain its retry key.
        error.resetRequestSent = consumeSent;
        reject(error);
      }
      else resolve(value);
    };
    const send = (message) => {
      try {
        if (!child.stdin || child.stdin.destroyed) return false;
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch { return false; }
    };
    const timer = setTimeout(() => finish(new Error(
      consumeSent
        ? "Reset redemption status is uncertain; retry with the saved attempt key."
        : "Codex reset preflight timed out; no credit was requested.",
    )), timeoutMs);
    child.stdin?.on?.("error", () => finish(new Error(
      consumeSent
        ? "Reset redemption status is uncertain; retry with the saved attempt key."
        : "Codex reset preflight failed; no credit was requested.",
    )));
    child.once("error", () => finish(new Error("The Codex app-server could not be started.")));
    child.once("close", (code) => {
      if (!settled) finish(new Error(consumeSent
        ? "Reset redemption status is uncertain; retry with the saved attempt key."
        : `Codex app-server exited before reset preflight (${code ?? "signal"}).`));
    });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server initialization failed."));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "account/read", params: { refreshToken: false } });
        send({ id: 3, method: "account/rateLimits/read", params: null });
        return;
      }
      if (message.id === 2 || message.id === 3) {
        if (message.error) {
          finish(new Error("The account identity or reset credits could not be verified."));
          return;
        }
        if (message.id === 2) account = message.result?.account;
        else limits = message.result;
        if (account === undefined || limits === undefined) return;
        if (
          account?.type !== "chatgpt"
          || typeof account.email !== "string"
          || account.email.toLowerCase() !== expectedEmail.toLowerCase()
          || limits?.accountId !== expectedAccountId
        ) {
          finish(new Error("The isolated Codex login does not match the registered account; no credit was spent."));
          return;
        }
        if (!(normalizeResetCredits(limits)?.availableCount > 0)) {
          const error = new Error("This account has no verified banked reset credit available.");
          error.code = "RESET_NO_CREDIT";
          finish(error);
          return;
        }
        const windows = [limits?.rateLimits?.primary, limits?.rateLimits?.secondary];
        if (!windows.some((window) => Number.isFinite(window?.usedPercent) && window.usedPercent >= 90)) {
          const error = new Error("A banked reset can be redeemed when this account's quota is at least 90% used.");
          error.code = "RESET_QUOTA_NOT_READY";
          finish(error);
          return;
        }
        // Mark the attempt before writing: a stream can emit EPIPE from within
        // write(), before send() returns, and we must not call that safe.
        consumeSent = true;
        if (!send({
          id: 4,
          method: "account/rateLimitResetCredit/consume",
          params: { idempotencyKey },
        })) finish(new Error("Reset redemption status is uncertain; retry with the saved attempt key."));
        return;
      }
      if (message.id !== 4 || !consumeSent) return;
      if (message.error) {
        finish(new Error("The banked reset status is uncertain; retry or check this account's quota in Codex."));
        return;
      }
      const outcome = message.result?.outcome;
      if (!["reset", "nothingToReset", "noCredit", "alreadyRedeemed"].includes(outcome)) {
        finish(new Error("Reset redemption status is uncertain; retry with the saved attempt key."));
        return;
      }
      finish(undefined, { outcome });
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codex_router_tray", title: "Codex Router Tray", version: "0.4.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function attachBoundedChatGPTAccountUsage(pool, {
  readUsage = readCodexAccountUsage,
  accountHome,
  probeLimit = ACCOUNT_POOL_USAGE_PROBE_LIMIT,
  timeoutMs = ACCOUNT_POOL_USAGE_TIMEOUT_MS,
  minAccessLifetimeMs = 0,
} = {}) {
  if (!pool?.accounts || typeof accountHome !== "function") return pool;
  const selectedId = pool.policy?.selectedAccountId;
  const candidates = Object.values(pool.accounts)
    .filter((account) => account?.subscription?.usable === true)
    .sort((left, right) => Number(right.id === selectedId) - Number(left.id === selectedId))
    .slice(0, Math.max(0, Math.floor(probeLimit)));
  await Promise.all(candidates.map(async (account) => {
    try {
      const usage = await readUsage({ codexHome: accountHome(account.id), timeoutMs, minAccessLifetimeMs });
      const windows = [usage.primary, usage.secondary].filter(Boolean);
      const monthly = windows.find((window) => window.windowDurationMins >= 28 * 24 * 60);
      const weekly = windows.find(
        (window) => window.windowDurationMins >= 7 * 24 * 60
          && window.windowDurationMins < 28 * 24 * 60,
      );
      const selected = weekly || monthly || windows[0];
      if (selected) {
        account.subscription.usage = {
          period: selected === weekly ? "weekly" : selected === monthly ? "monthly" : "current",
          remainingPercent: selected.remainingPercent,
          ...(selected.resetsAt ? { resetsAt: selected.resetsAt } : {}),
        };
      }
    } catch {
      // Per-account usage is optional. Core account/session state remains
      // available even when the bounded app-server probe cannot answer.
    }
  }));
  return pool;
}

export function readCodexAccountUsage({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  binary = codexBinary(),
  platform = process.platform,
  codexHome = process.env.CODEX_HOME,
  spawnImpl = spawn,
  minAccessLifetimeMs = 0,
} = {}) {
  return new Promise((resolve, reject) => {
    // The app-server answers with the signed-in ChatGPT account's usage, which
    // makes this a live credential probe against the real CODEX_HOME -- the
    // same class of read codexAuthStatus() refuses. The tray polls this every
    // 30 seconds, so an unguarded spawn here would quietly break the
    // --no-discovery promise in the background.
    if (discoveryDisabled()) {
      reject(new Error("Credential discovery is disabled (--no-discovery); the Codex account is not read."));
      return;
    }
    if (!binary) {
      reject(new Error("The Codex app-server could not be started: no Codex binary was found."));
      return;
    }
    if (minAccessLifetimeMs > 0) {
      try {
        const auth = JSON.parse(readFileSync(path.join(codexHome, "auth.json"), "utf8"));
        const expiresAt = tokenExpiryMs(auth?.tokens?.access_token);
        if (!Number.isFinite(expiresAt) || expiresAt - Date.now() <= minAccessLifetimeMs) {
          reject(new Error("The login owner needs to refresh this access token before background usage probing."));
          return;
        }
      } catch {
        reject(new Error("The login owner needs to restore this account before background usage probing."));
        return;
      }
    }
    const target = spawnableCommand(binary, ["app-server"], platform);
    const processHandle = spawnImpl(target.command, target.args, {
      ...target.options,
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: processHandle.stdout });
    const responses = new Map();
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killProcessTree(processHandle, Boolean(target.options.windowsVerbatimArguments));
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message) => {
      try {
        if (!processHandle.stdin || processHandle.stdin.destroyed) return false;
        return processHandle.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        return false;
      }
    };
    // An absent answer is the same class of event as a refused one, and the
    // refused case is already tolerated below. Waiting for both meant one read
    // that never came back discarded the other one's answer: on a machine where
    // account/rateLimits/read hung and account/usage/read returned a full daily
    // ledger, this rejected, the caller had no account usage at all, and every
    // surface fell back to publishing zero. Keep whatever arrived; only a window
    // that produced nothing is a failure.
    const emptyResponse = (id) => (
      id === 2 ? { rateLimits: {} } : { summary: {}, dailyUsageBuckets: [] }
    );
    const partialUsage = () => normalizeCodexAccountUsage(
      responses.get(2) ?? emptyResponse(2),
      responses.get(3) ?? emptyResponse(3),
    );
    const timer = setTimeout(
      () => {
        if (responses.size === 0) {
          finish(new Error("Codex account usage request timed out."));
          return;
        }
        finish(undefined, partialUsage());
      },
      timeoutMs,
    );

    processHandle.once("error", () => {
      finish(new Error("The Codex app-server could not be started."));
    });
    // An app-server that dies after answering one account read is the absent
    // answer above arriving early, so it keeps the half that arrived. That exit
    // used to reject, and Control Center painted the Node stack as "Some router
    // data could not load" over an otherwise healthy snapshot. Settle on
    // `close`, not `exit`: Node can report the exit while the last reply is
    // still in the stdout pipe, and closing the reader there discards an answer
    // the app-server had already written.
    processHandle.once("close", (code) => {
      if (settled) return;
      if (responses.size > 0) {
        finish(undefined, partialUsage());
        return;
      }
      finish(new Error(`Codex app-server exited before replying (${code ?? "signal"}).`));
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server initialization failed."));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "account/rateLimits/read", params: null });
        send({ id: 3, method: "account/usage/read", params: null });
        return;
      }
      if (message.id !== 2 && message.id !== 3) return;
      // Both account reads are optional for the Control Center. A ChatGPT login
      // can answer one and refuse the other (API-key sessions, transient
      // app-server races). Hard-failing rateLimits used to paint the whole
      // Models page with a stack trace while the snapshot itself was fine.
      if (message.error) {
        responses.set(message.id, { ...emptyResponse(message.id), error: message.error });
      } else {
        responses.set(message.id, message.result);
      }
      if (responses.size === 2) {
        finish(undefined, partialUsage());
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_router_tray",
          title: "Codex Router Tray",
          version: "0.4.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
