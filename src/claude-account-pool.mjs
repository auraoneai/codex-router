import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { privateFileIsProtected, protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import {
  CLAUDE_ACCOUNT_HOMES_DIR,
  CLAUDE_ACCOUNT_POOL_PATH,
} from "./paths.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";

export const CLAUDE_ACCOUNT_POOL_SCHEMA_VERSION = 1;

const ACCOUNT_ID = /^clacct_[A-Za-z0-9_-]{8,80}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ACCOUNTS = 64;
const MAX_ERROR_LENGTH = 512;
const EXPIRY_SKEW_MS = 120_000;

const ALLOWED_ROOT_KEYS = new Set(["version", "policy", "accounts"]);
const ALLOWED_POLICY_KEYS = new Set(["enabled", "mode", "selectedAccountId"]);
const ALLOWED_ACCOUNT_KEYS = new Set([
  "id",
  "state",
  "paused",
  "priority",
  "label",
  "purpose",
  "createdAt",
  "identity",
  "subscription",
  "health",
  "turns",
  "requests",
]);
const ALLOWED_IDENTITY_KEYS = new Set(["accountId", "email", "organizationUuid"]);
const ALLOWED_SUBSCRIPTION_KEYS = new Set([
  "status",
  "plan",
  "authenticated",
  "usable",
  "expired",
  "email",
  "hasAccountId",
]);
const ALLOWED_HEALTH_KEYS = new Set([
  "state",
  "cooldownUntil",
  "lastSuccessAt",
  "lastErrorAt",
  "lastUsedAt",
  "lastStatus",
  "lastError",
]);
const ALLOWED_PURPOSES = new Set(["personal", "auraone", "veerone", "foundation", "reserve"]);

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) {
      invalidPoolState(`${field} contains unsupported field ${key}`);
    }
  }
}

function assertAccountDiscoveryEnabled() {
  if (discoveryDisabled()) {
    throw new Error(
      "Claude account profiles are unavailable while credential discovery is disabled.",
    );
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}
function iso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function isoNow(now = Date.now()) {
  return new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
}

function accountId(value) {
  const id = text(value);
  if (!ACCOUNT_ID.test(id)) throw new Error("accountId must be an opaque clacct_ identifier.");
  return id;
}

export function isClaudeAccountId(value) {
  return typeof value === "string" && ACCOUNT_ID.test(value.trim());
}

function normalizePolicy(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const selected = text(source.selectedAccountId);
  return {
    enabled: source.enabled !== false,
    mode: "switch",
    ...(ACCOUNT_ID.test(selected) ? { selectedAccountId: selected } : {}),
  };
}

function normalizeIdentity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = text(raw.accountId);
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return {
    accountId: value,
    ...(text(raw.email) ? { email: text(raw.email).slice(0, 320) } : {}),
    ...(text(raw.organizationUuid) ? { organizationUuid: text(raw.organizationUuid).slice(0, 120) } : {}),
  };
}

function normalizeHealth(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const state = ["healthy", "cooldown", "reauth-required", "failed"].includes(source.state)
    ? source.state
    : "healthy";
  return {
    state,
    ...(iso(source.cooldownUntil) ? { cooldownUntil: iso(source.cooldownUntil) } : {}),
    ...(iso(source.lastSuccessAt) ? { lastSuccessAt: iso(source.lastSuccessAt) } : {}),
    ...(iso(source.lastErrorAt) ? { lastErrorAt: iso(source.lastErrorAt) } : {}),
    ...(iso(source.lastUsedAt) ? { lastUsedAt: iso(source.lastUsedAt) } : {}),
    ...(number(source.lastStatus) !== undefined
      ? { lastStatus: integer(source.lastStatus, 500, { min: 100, max: 999 }) }
      : {}),
    ...(text(source.lastError) ? { lastError: text(source.lastError).slice(0, MAX_ERROR_LENGTH) } : {}),
  };
}

function normalizeSubscription(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const status = ["pending", "usable", "expired", "invalid"].includes(raw.status)
    ? raw.status
    : "pending";
  const plan = ["pro", "max5", "max20", "team", "unknown"].includes(raw.plan)
    ? raw.plan
    : undefined;
  return {
    status,
    ...(plan ? { plan } : {}),
    ...(typeof raw.authenticated === "boolean" ? { authenticated: raw.authenticated } : {}),
    ...(typeof raw.usable === "boolean" ? { usable: raw.usable } : {}),
    ...(typeof raw.expired === "boolean" ? { expired: raw.expired } : {}),
    ...(typeof raw.hasAccountId === "boolean" ? { hasAccountId: raw.hasAccountId } : {}),
    ...(text(raw.email) ? { email: text(raw.email).slice(0, 320) } : {}),
  };
}

function normalizeAccount(raw, id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const state = ["active", "paused", "revoked"].includes(raw.state) ? raw.state : "active";
  const identity = normalizeIdentity(raw.identity);
  const subscription = normalizeSubscription(raw.subscription);
  const purpose = ALLOWED_PURPOSES.has(raw.purpose) ? raw.purpose : undefined;
  return {
    id,
    state,
    paused: raw.paused === true,
    priority: integer(raw.priority, 50, { min: 0, max: 100_000 }),
    ...(text(raw.label) ? { label: text(raw.label).slice(0, 120) } : {}),
    ...(purpose ? { purpose } : {}),
    ...(iso(raw.createdAt) ? { createdAt: iso(raw.createdAt) } : {}),
    ...(identity ? { identity } : {}),
    ...(subscription ? { subscription } : {}),
    health: normalizeHealth(raw.health),
    turns: integer(raw.turns, 0),
    requests: integer(raw.requests, 0),
  };
}

function emptyState() {
  return {
    version: CLAUDE_ACCOUNT_POOL_SCHEMA_VERSION,
    policy: normalizePolicy(),
    accounts: {},
  };
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidPoolState(reason) {
  throw new Error(`The saved Claude account list is invalid: ${reason}.`);
}

function validatePersistedState(raw) {
  if (!plainObject(raw)) invalidPoolState("the document root must be an object");
  assertAllowedKeys(raw, ALLOWED_ROOT_KEYS, "Claude account pool");
  if (raw.version !== CLAUDE_ACCOUNT_POOL_SCHEMA_VERSION) {
    invalidPoolState(`unsupported schema version ${String(raw.version)}`);
  }
  if (!plainObject(raw.policy)) invalidPoolState("policy must be an object");
  assertAllowedKeys(raw.policy, ALLOWED_POLICY_KEYS, "policy");
  if (typeof raw.policy.enabled !== "boolean" || raw.policy.mode !== "switch") {
    invalidPoolState("policy is malformed");
  }
  if (
    raw.policy.selectedAccountId !== undefined &&
    !isClaudeAccountId(raw.policy.selectedAccountId)
  ) {
    invalidPoolState("the selected account id is malformed");
  }
  if (!plainObject(raw.accounts)) invalidPoolState("accounts must be an object");
  const entries = Object.entries(raw.accounts);
  if (entries.length > MAX_ACCOUNTS) {
    invalidPoolState(`more than ${MAX_ACCOUNTS} accounts are present`);
  }
  for (const [id, account] of entries) {
    if (!isClaudeAccountId(id) || !plainObject(account) || account.id !== id) {
      invalidPoolState("an account record is malformed");
    }
    assertAllowedKeys(account, ALLOWED_ACCOUNT_KEYS, `account ${id}`);
    if (!["active", "paused", "revoked"].includes(account.state)) {
      invalidPoolState(`account ${id} has an invalid state`);
    }
    if (typeof account.paused !== "boolean" || !Number.isFinite(account.priority)) {
      invalidPoolState(`account ${id} has invalid routing metadata`);
    }
    if (account.purpose !== undefined && !ALLOWED_PURPOSES.has(account.purpose)) {
      invalidPoolState(`account ${id} has an invalid purpose`);
    }
    if (
      !plainObject(account.health) ||
      !["healthy", "cooldown", "reauth-required", "failed"].includes(account.health.state)
    ) {
      invalidPoolState(`account ${id} has invalid health metadata`);
    }
    assertAllowedKeys(account.health, ALLOWED_HEALTH_KEYS, `account ${id} health`);
    if (!Number.isFinite(account.turns) || !Number.isFinite(account.requests)) {
      invalidPoolState(`account ${id} has invalid counters`);
    }
    if (account.identity !== undefined) {
      if (!plainObject(account.identity)) invalidPoolState(`account ${id} identity must be an object`);
      assertAllowedKeys(account.identity, ALLOWED_IDENTITY_KEYS, `account ${id} identity`);
      if (!normalizeIdentity(account.identity)) {
        invalidPoolState(`account ${id} has an invalid identity`);
      }
    }
    if (account.subscription !== undefined) {
      if (!plainObject(account.subscription)) invalidPoolState(`account ${id} subscription must be an object`);
      assertAllowedKeys(account.subscription, ALLOWED_SUBSCRIPTION_KEYS, `account ${id} subscription`);
      if (!normalizeSubscription(account.subscription)) {
        invalidPoolState(`account ${id} has invalid subscription metadata`);
      }
    }
  }
  if (
    raw.policy.selectedAccountId !== undefined &&
    !Object.hasOwn(raw.accounts, raw.policy.selectedAccountId)
  ) {
    invalidPoolState("the selected account is not registered");
  }
  return raw;
}

function normalizeState(raw) {
  const result = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  result.policy = normalizePolicy(raw.policy);
  for (const [id, value] of Object.entries(raw.accounts || {}).slice(0, MAX_ACCOUNTS)) {
    if (!ACCOUNT_ID.test(id)) continue;
    const account = normalizeAccount(value, id);
    if (account) result.accounts[id] = account;
  }
  return result;
}

export function readClaudeAccountPoolState(filePath = CLAUDE_ACCOUNT_POOL_PATH) {
  assertAccountDiscoveryEnabled();
  let file;
  try {
    file = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new Error("The saved Claude account list could not be inspected.", { cause: error });
  }
  if (file.isSymbolicLink() || !file.isFile()) {
    invalidPoolState("the state path is not a regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error("The saved Claude account list could not be read as JSON.", { cause: error });
  }
  return normalizeState(validatePersistedState(parsed));
}

export function writeClaudeAccountPoolState(state, filePath = CLAUDE_ACCOUNT_POOL_PATH) {
  assertAccountDiscoveryEnabled();
  validatePersistedState(state);
  const normalized = normalizeState({ ...state, version: CLAUDE_ACCOUNT_POOL_SCHEMA_VERSION });
  writePrivateJson(filePath, normalized, { directoryMode: 0o700 });
  return normalized;
}

function newAccountId(state) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `clacct_${randomBytes(12).toString("base64url")}`;
    if (!state.accounts[id]) return id;
  }
  throw new Error("Could not allocate a unique Claude account id.");
}

function ensurePrivateAccountDirectory(target, homesDir) {
  const root = path.resolve(homesDir);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Claude account profile escaped its private home directory.");
  }
  ensureNoSymlinkParents(path.dirname(root), { label: "Claude account home parent" });
  if (existsSync(root)) {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Claude account home directory is not a private directory.");
    }
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  ensureNoSymlinkParents(root, { label: "Claude account home" });
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(absolute, { label: "Claude account profile" });
  const accountStat = lstatSync(absolute);
  if (accountStat.isSymbolicLink() || !accountStat.isDirectory()) {
    throw new Error("Claude account profile directory is not a private directory.");
  }
  chmodSync(root, 0o700);
  chmodSync(absolute, 0o700);
}

function nextAccountLabel(state) {
  const used = new Set(
    Object.values(state.accounts)
      .filter((account) => account?.state !== "revoked")
      .map((account) => {
        const match = /^Claude account (\d+)$/.exec(account?.label || "");
        return match ? Number(match[1]) : undefined;
      })
      .filter(Number.isInteger),
  );
  let numberValue = 1;
  while (used.has(numberValue)) numberValue += 1;
  return `Claude account ${numberValue}`;
}

export function createClaudeSubscriptionAccount({
  label = "",
  purpose,
  priority = 50,
  filePath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  now = Date.now(),
} = {}) {
  const state = readClaudeAccountPoolState(filePath);
  if (
    Object.values(state.accounts).filter((account) => account?.state !== "revoked").length >=
    MAX_ACCOUNTS
  ) {
    throw new Error(`The Claude account list supports at most ${MAX_ACCOUNTS} accounts.`);
  }
  const id = newAccountId(state);
  const home = claudeSubscriptionAccountHome(id, { homesDir });
  ensurePrivateAccountDirectory(home, homesDir);
  const account = normalizeAccount(
    {
      id,
      state: "active",
      label: text(label).slice(0, 120) || nextAccountLabel(state),
      ...(purpose ? { purpose } : {}),
      priority,
      createdAt: isoNow(now),
      subscription: { status: "pending" },
      health: { state: "healthy" },
    },
    id,
  );
  state.accounts[id] = account;
  try {
    writeClaudeAccountPoolState(state, filePath);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return sanitizeClaudeAccount(account);
}

export function claudeSubscriptionAccountHome(
  accountValue,
  { homesDir = CLAUDE_ACCOUNT_HOMES_DIR } = {},
) {
  return path.join(homesDir, accountId(accountValue));
}

export function claudeSubscriptionAccountCredentialsPath(accountValue, options = {}) {
  return path.join(claudeSubscriptionAccountHome(accountValue, options), "credentials.json");
}

export function removeClaudeSubscriptionAccount(
  accountValue,
  {
    filePath = CLAUDE_ACCOUNT_POOL_PATH,
    homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
    selectedAccountId,
  } = {},
) {
  const id = accountId(accountValue);
  const state = readClaudeAccountPoolState(filePath);
  const removed = state.accounts[id];
  if (!removed) throw new Error("Account id is not registered.");
  delete state.accounts[id];
  if (selectedAccountId !== undefined) {
    const selected = accountId(selectedAccountId);
    const account = state.accounts[selected];
    if (!account || account.state !== "active" || account.paused) {
      throw new Error("The replacement Claude account is not active.");
    }
    state.policy.selectedAccountId = selected;
  } else if (state.policy.selectedAccountId === id) {
    delete state.policy.selectedAccountId;
  }
  const root = path.resolve(homesDir);
  const home = path.resolve(claudeSubscriptionAccountHome(id, { homesDir }));
  ensureNoSymlinkParents(root, { label: "Claude account removal root" });
  ensureNoSymlinkParents(home, { label: "Claude account removal target" });
  const rootStat = lstatSync(root);
  const homeStat = lstatSync(home);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Claude account removal root is not a private directory.");
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error("Claude account removal target is not an owned directory.");
  }
  const realRoot = realpathSync(root);
  if (path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("Claude account removal target escaped its private root.");
  }
  const tombstone = path.join(root, `.removed-${id}-${randomBytes(8).toString("hex")}`);
  ensureNoSymlinkParents(root, { label: "Claude account removal root" });
  ensureNoSymlinkParents(home, { label: "Claude account removal target" });
  if (realpathSync(root) !== realRoot || path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("Claude account removal target changed during validation.");
  }
  renameSync(home, tombstone);
  let committed = false;
  try {
    const staged = lstatSync(tombstone);
    if (
      staged.isSymbolicLink() ||
      !staged.isDirectory() ||
      path.dirname(realpathSync(tombstone)) !== realRoot
    ) {
      throw new Error("Claude account removal staging target is not an owned directory.");
    }
    try {
      writeClaudeAccountPoolState(state, filePath);
    } catch (error) {
      renameSync(tombstone, home);
      throw error;
    }
    committed = true;
  } catch (error) {
    if (existsSync(tombstone) && !existsSync(home)) {
      try {
        renameSync(tombstone, home);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Claude account removal staging rollback failed.",
        );
      }
    }
    throw error;
  }
  if (committed) {
    try {
      const cleanup = lstatSync(tombstone);
      if (
        !cleanup.isSymbolicLink() &&
        cleanup.isDirectory() &&
        path.dirname(realpathSync(tombstone)) === realRoot
      ) {
        rmSync(tombstone, { recursive: true, force: true });
      }
    } catch {}
  }
  return sanitizeClaudeAccount({ ...removed, state: "revoked", paused: true });
}

function parseTokenExpiryMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const num = Number(value);
    if (Number.isFinite(num)) return num >= 1e12 ? num : num * 1000;
  }
  return undefined;
}

export function claudeSubscriptionAccountStatus(
  accountValue,
  { homesDir = CLAUDE_ACCOUNT_HOMES_DIR, now = Date.now(), home } = {},
) {
  const credPath = home
    ? path.join(home, "credentials.json")
    : claudeSubscriptionAccountCredentialsPath(accountValue, { homesDir });
  if (!existsSync(credPath)) {
    return {
      status: "pending",
      authenticated: false,
      usable: false,
      expired: false,
      hasAccountId: false,
    };
  }
  try {
    const file = lstatSync(credPath);
    if (file.isSymbolicLink() || !file.isFile()) {
      return {
        status: "pending",
        authenticated: false,
        usable: false,
        expired: false,
        hasAccountId: false,
      };
    }
    if (!privateFileIsProtected(credPath)) {
      return {
        status: "invalid",
        authenticated: false,
        usable: false,
        expired: false,
        hasAccountId: false,
      };
    }
    const parsed = JSON.parse(readFileSync(credPath, "utf8"));
    const blob = parsed?.claudeAiOauth || parsed;
    const accessToken = typeof blob?.accessToken === "string" ? blob.accessToken.trim() : "";
    const refreshToken = typeof blob?.refreshToken === "string" ? blob.refreshToken.trim() : "";
    const expiresAtMs = parseTokenExpiryMs(blob?.expiresAt);
    const expired = expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= now;
    const authenticated = Boolean(accessToken || refreshToken);
    const usable = Boolean(accessToken) && !expired;
    const email = typeof blob?.email === "string" && EMAIL.test(blob.email.trim())
      ? blob.email.trim()
      : undefined;
    const accountIdValue = typeof blob?.accountUuid === "string" || typeof blob?.accountId === "string"
      ? (blob.accountUuid || blob.accountId).trim()
      : undefined;
    return {
      status: usable ? "usable" : expired ? "expired" : authenticated ? "invalid" : "pending",
      authenticated,
      usable,
      expired,
      hasAccountId: Boolean(accountIdValue),
      ...(email ? { email } : {}),
      ...(expiresAtMs ? { expiresAtMs } : {}),
    };
  } catch {
    return {
      status: "invalid",
      authenticated: false,
      usable: false,
      expired: false,
      hasAccountId: false,
    };
  }
}

export function claudeSubscriptionAccountPoolSnapshot({
  filePath = CLAUDE_ACCOUNT_POOL_PATH,
  homesDir = CLAUDE_ACCOUNT_HOMES_DIR,
  now = Date.now(),
} = {}) {
  assertAccountDiscoveryEnabled();
  const state = readClaudeAccountPoolState(filePath);
  const sanitized = sanitizeClaudeAccountPool(state);
  for (const [id, account] of Object.entries(sanitized.accounts)) {
    const status = claudeSubscriptionAccountStatus(id, { homesDir, now });
    account.subscription = {
      ...(account.subscription || {}),
      status: status.usable ? "usable" : status.expired ? "expired" : status.authenticated ? "invalid" : "pending",
      ...status,
    };
  }
  return sanitized;
}

export function sanitizeClaudeAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    state: account.state,
    paused: account.paused === true,
    priority: account.priority,
    ...(account.label ? { label: account.label } : {}),
    ...(account.purpose ? { purpose: account.purpose } : {}),
    ...(account.createdAt ? { createdAt: account.createdAt } : {}),
    ...(account.identity ? { identity: { ...account.identity } } : {}),
    ...(account.subscription ? { subscription: { ...account.subscription } } : {}),
    health: {
      ...account.health,
      ...(account.health?.lastError ? { lastError: "[redacted]" } : {}),
    },
    turns: account.turns,
    requests: account.requests,
  };
}

export function sanitizeClaudeAccountPool(state) {
  const normalized = normalizeState(state);
  return {
    version: CLAUDE_ACCOUNT_POOL_SCHEMA_VERSION,
    policy: { ...normalized.policy },
    accounts: Object.fromEntries(
      Object.entries(normalized.accounts).map(([id, account]) => [
        id,
        sanitizeClaudeAccount(account),
      ]),
    ),
  };
}

export async function withClaudeAccountPoolLock(
  operation,
  {
    filePath = CLAUDE_ACCOUNT_POOL_PATH,
    waitMs = 120_000,
    retryMs = 25,
    staleMs = 10 * 60_000,
  } = {},
) {
  assertAccountDiscoveryEnabled();
  const lockTarget = `${filePath}.pool-lock`;
  const lockPath = `${lockTarget}.lock`;
  const retries = Math.max(0, Math.ceil(waitMs / retryMs) - 1);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const { default: lockfile } = await import("proper-lockfile");
  let release;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      lockfilePath: lockPath,
      stale: Math.max(2_000, staleMs),
      retries: {
        retries,
        factor: 1,
        minTimeout: retryMs,
        maxTimeout: retryMs,
        randomize: false,
      },
    });
    return await operation();
  } finally {
    if (release) await release().catch(() => {});
  }
}

export function claudeAccountPoolConfigured({ filePath = CLAUDE_ACCOUNT_POOL_PATH } = {}) {
  try {
    if (discoveryDisabled()) return false;
    const state = readClaudeAccountPoolState(filePath);
    if (!state.policy?.enabled) return false;
    const active = Object.values(state.accounts || {}).filter(
      (account) => account.state === "active" && !account.paused,
    );
    return active.length > 0;
  } catch {
    return false;
  }
}
