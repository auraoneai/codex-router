import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";
import {
  CLAUDE_ACCOUNT_HOMES_DIR,
  CLAUDE_ACCOUNT_POOL_PATH,
} from "./paths.mjs";
import {
  createClaudeSubscriptionAccount,
  claudeSubscriptionAccountCredentialsPath,
  readClaudeAccountPoolState,
  sanitizeClaudeAccount,
  withClaudeAccountPoolLock,
  writeClaudeAccountPoolState,
} from "./claude-account-pool.mjs";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

function defaultClaudeCredentialsPath() {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

export function credentialFingerprint(credentials) {
  const blob = credentials?.claudeAiOauth || credentials || {};
  const refreshToken = typeof blob.refreshToken === "string" ? blob.refreshToken.trim() : "";
  if (refreshToken) {
    return createHash("sha256").update(refreshToken).digest("hex");
  }
  const accessToken = typeof blob.accessToken === "string" ? blob.accessToken.trim() : "";
  if (accessToken) {
    return createHash("sha256").update(accessToken).digest("hex");
  }
  return createHash("sha256").update(JSON.stringify(blob)).digest("hex");
}

function hasToken(data) {
  if (!data || typeof data !== "object") return false;
  const blob = data.claudeAiOauth || data;
  return Boolean(
    (typeof blob.accessToken === "string" && blob.accessToken.trim()) ||
    (typeof blob.refreshToken === "string" && blob.refreshToken.trim())
  );
}

function readKeychainSecret(args, { securityBinary = "/usr/bin/security", execFileSyncImpl = execFileSync } = {}) {
  try {
    const raw = execFileSyncImpl(securityBinary, args, {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (hasToken(parsed)) {
      return parsed;
    }
  } catch {
    // Missing item or not JSON or keychain locked
  }
  return undefined;
}

export function readClaudeCodeCredentials({
  platform = process.platform,
  env = process.env,
  securityBinary = env.CLAUDE_SECURITY_BIN || "/usr/bin/security",
  execFileSyncImpl = execFileSync,
  credentialsFile = env.CLAUDE_CREDENTIALS_FILE || defaultClaudeCredentialsPath(),
} = {}) {
  if (discoveryDisabled()) return undefined;

  // On macOS, try Keychain first per teamclaude precedence
  if (platform === "darwin") {
    const username = env.USER || env.LOGNAME || "";
    if (username) {
      const userItem = readKeychainSecret(
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", username, "-w"],
        { securityBinary, execFileSyncImpl },
      );
      if (userItem) return userItem;
    }

    const serviceItem = readKeychainSecret(
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { securityBinary, execFileSyncImpl },
    );
    if (serviceItem) return serviceItem;
  }

  // Fall back to ~/.claude/.credentials.json on macOS, or primary on Linux/Windows
  if (!existsSync(credentialsFile)) return undefined;
  try {
    const file = lstatSync(credentialsFile);
    if (file.isSymbolicLink() || !file.isFile()) return undefined;
    const raw = readFileSync(credentialsFile, "utf8");
    const parsed = JSON.parse(raw);
    if (hasToken(parsed)) {
      return parsed;
    }
  } catch {
    // Unreadable or malformed JSON
  }

  return undefined;
}

export async function resolveClaudeIdentity(accessToken, {
  profileUrl = PROFILE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!accessToken || typeof accessToken !== "string") return undefined;
  if (discoveryDisabled()) return undefined;

  try {
    const response = await fetchImpl(profileUrl, {
      headers: {
        Authorization: `Bearer ${accessToken.trim()}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    const accountUuid = typeof data?.account?.uuid === "string" ? data.account.uuid.trim() : "";
    if (!accountUuid) return undefined;

    const email = typeof data?.account?.email_address === "string"
      ? data.account.email_address.trim()
      : typeof data?.account?.email === "string"
        ? data.account.email.trim()
        : undefined;
    const organizationUuid = typeof data?.organization?.uuid === "string"
      ? data.organization.uuid.trim()
      : undefined;

    return {
      accountId: accountUuid,
      ...(email ? { email } : {}),
      ...(organizationUuid ? { organizationUuid } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function importClaudeAccount(label, {
  filePath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  platform = process.platform,
  env = process.env,
  securityBinary = env.CLAUDE_SECURITY_BIN || "/usr/bin/security",
  execFileSyncImpl = execFileSync,
  credentialsFile = env.CLAUDE_CREDENTIALS_FILE || defaultClaudeCredentialsPath(),
  profileUrl = PROFILE_URL,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  if (discoveryDisabled()) return null;

  const credentials = readClaudeCodeCredentials({
    platform,
    env,
    securityBinary,
    execFileSyncImpl,
    credentialsFile,
  });

  if (!credentials) {
    throw new Error("No valid Claude Code credentials found. Please log in with 'claude' first.");
  }

  const blob = credentials.claudeAiOauth || credentials;
  const accessToken = typeof blob.accessToken === "string" ? blob.accessToken.trim() : "";
  const fingerprint = credentialFingerprint(blob);

  // Resolve identity if accessToken available
  let identity;
  if (accessToken) {
    identity = await resolveClaudeIdentity(accessToken, { profileUrl, fetchImpl });
  }

  return await withClaudeAccountPoolLock(async () => {
    const state = readClaudeAccountPoolState(filePath);

    // Look for existing account by identity or by fingerprint of stored credentials
    let existingAccount;
    for (const acc of Object.values(state.accounts || {})) {
      if (acc.state === "revoked") continue;
      if (identity?.accountId && acc.identity?.accountId === identity.accountId) {
        existingAccount = acc;
        break;
      }
      // Check stored credentials fingerprint
      const credPath = claudeSubscriptionAccountCredentialsPath(acc.id, { homesDir });
      if (existsSync(credPath)) {
        try {
          const storedCreds = JSON.parse(readFileSync(credPath, "utf8"));
          if (credentialFingerprint(storedCreds) === fingerprint) {
            existingAccount = acc;
            break;
          }
        } catch {}
      }
    }

    if (existingAccount) {
      const trimmedLabel = typeof label === "string" ? label.trim() : "";
      if (trimmedLabel.includes("@") && identity?.email && trimmedLabel.toLowerCase() !== identity.email.toLowerCase()) {
        throw new Error(
          `Claude Code is currently authenticated as ${identity.email}, which is already registered. To add ${trimmedLabel}, sign into that account with 'claude auth login --email ${trimmedLabel}' first.`,
        );
      }
      if (existingAccount.health?.state !== "reauth-required" && !trimmedLabel) {
        throw new Error(
          `Claude account ${identity?.email || existingAccount.label || existingAccount.id} is already registered. To add a new account, sign into that account with 'claude auth login' first.`,
        );
      }

      // Update in place
      const credPath = claudeSubscriptionAccountCredentialsPath(existingAccount.id, { homesDir });
      writePrivateJson(credPath, { claudeAiOauth: blob }, { directoryMode: 0o700, fileMode: 0o600 });

      if (trimmedLabel) {
        existingAccount.label = trimmedLabel.slice(0, 120);
      } else if (identity?.email && (!existingAccount.label || /^Claude account \d+$/.test(existingAccount.label))) {
        existingAccount.label = identity.email.slice(0, 120);
      }

      if (identity) {
        existingAccount.identity = identity;
      }
      existingAccount.health = {
        state: "healthy",
        lastSuccessAt: existingAccount.health?.lastSuccessAt,
      };
      existingAccount.subscription = {
        status: "usable",
      };

      writeClaudeAccountPoolState(state, filePath);
      return sanitizeClaudeAccount(existingAccount);
    }

    // Create new account
    const accountLabel = (label && typeof label === "string" && label.trim())
      ? label.trim().slice(0, 120)
      : identity?.email
        ? identity.email.slice(0, 120)
        : "";

    const created = createClaudeSubscriptionAccount({
      label: accountLabel,
      filePath,
      homesDir,
      now,
    });

    const newCredPath = claudeSubscriptionAccountCredentialsPath(created.id, { homesDir });
    writePrivateJson(newCredPath, { claudeAiOauth: blob }, { directoryMode: 0o700, fileMode: 0o600 });

    const updatedState = readClaudeAccountPoolState(filePath);
    const poolAccount = updatedState.accounts[created.id];
    if (poolAccount) {
      if (identity) poolAccount.identity = identity;
      poolAccount.subscription = { status: "usable" };
      writeClaudeAccountPoolState(updatedState, filePath);
    }

    return sanitizeClaudeAccount(poolAccount || created);
  }, { filePath });
}
