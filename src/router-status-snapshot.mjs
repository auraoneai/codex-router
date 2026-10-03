// Serves the tray- and agent-polled status sections from the long-lived
// router process. Every poll used to boot a node process (and, for the
// overview, one probe child per target) to recompute slowly-moving numbers;
// the endpoint answers from the same snapshot files `control` already shares
// plus in-process builders for the usage rankings, so a burst of polls costs
// file reads instead of process spawns. Sections that need a recompute the
// router cannot run in-process (the overview's per-target probe fan-out)
// report staleness and let the `control` fallback rewarm the file.
import {
  CONTROL_SNAPSHOT_TTLS_MS,
  readControlSnapshotWithMeta,
  writeControlSnapshot,
} from "./control-snapshot-cache.mjs";
import {
  buildAccountUsageReport,
  buildChatGPTUsageReport,
  buildClaudeUsageReport,
  chatGPTUsageSnapshotPath,
  claudeUsageSnapshotPath,
  readUsageSnapshotFile,
} from "./pool-usage-report.mjs";

export const STATUS_SNAPSHOT_SECTIONS = Object.freeze([
  "overview",
  "account",
  "provider-usage",
  "providers",
  "chatgpt-usage",
  "claude-usage",
]);
const SECTION_SET = new Set(STATUS_SNAPSHOT_SECTIONS);
export const STATUS_SNAPSHOT_MAX_SECTIONS = STATUS_SNAPSHOT_SECTIONS.length;

// A poll must never wait on a recompute: the tray reads these on fixed
// cadences, and a slow ledger parse would serialize every poller behind it.
// Past this bound the caller gets the stale file (or an error when there is
// none) while the recompute finishes in the background; `control` treats the
// miss as a signal to compute locally, which is today's behavior.
const INLINE_COMPUTE_TIMEOUT_MS = 2_000;

// backgroundRefreshInFlight collapses concurrent stale reads into one
// recompute per section instead of one per poller.
const backgroundRefreshInFlight = new Map();

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function recomputeAccount() {
  const value = await buildAccountUsageReport();
  writeControlSnapshot("account", value);
  return value;
}

async function recomputeProviderUsage() {
  const { providerUsageSnapshot } = await import("./provider-usage.mjs");
  const value = await providerUsageSnapshot();
  writeControlSnapshot("provider-usage", value);
  return value;
}

async function recomputeProviders() {
  const { providerOnboardingSnapshot } = await import("./provider-onboarding.mjs");
  const value = await providerOnboardingSnapshot();
  writeControlSnapshot("providers", value);
  return value;
}

function triggerBackgroundRefresh(name, recompute) {
  if (backgroundRefreshInFlight.has(name)) return;
  const pending = Promise.resolve()
    .then(recompute)
    .catch((error) => {
      console.error(
        `[codex-router] status snapshot refresh failed for ${name}: ${error?.message || error}`,
      );
    })
    .finally(() => {
      if (backgroundRefreshInFlight.get(name) === pending) {
        backgroundRefreshInFlight.delete(name);
      }
    });
  backgroundRefreshInFlight.set(name, pending);
}

async function fileSection(
  name,
  recompute,
  { refresh, timeoutMs = INLINE_COMPUTE_TIMEOUT_MS, now = Date.now() } = {},
) {
  const entry = readControlSnapshotWithMeta(name);
  const ttl = CONTROL_SNAPSHOT_TTLS_MS[name];
  const fresh = Boolean(entry) && Number.isFinite(ttl) && now - entry.mtimeMs <= ttl;
  if (!refresh && fresh) return { data: entry.value, stale: false };
  if (!recompute) {
    // The overview's probe fan-out only runs in `control`; the endpoint
    // reports the file as-is and the CLI fallback rewarm it on a miss.
    if (entry) return { data: entry.value, stale: !fresh };
    return { error: "snapshot_unavailable" };
  }
  if (!refresh && entry) {
    triggerBackgroundRefresh(name, recompute);
    return { data: entry.value, stale: true };
  }
  try {
    const value = await withTimeout(
      Promise.resolve().then(recompute),
      timeoutMs,
      () => new Error("recompute_timeout"),
    );
    return { data: value, stale: false };
  } catch {
    if (entry) {
      triggerBackgroundRefresh(name, recompute);
      return { data: entry.value, stale: true };
    }
    return { error: "snapshot_unavailable" };
  }
}

async function usageSection(builder, { timeoutMs = INLINE_COMPUTE_TIMEOUT_MS } = {}) {
  try {
    const data = await withTimeout(Promise.resolve().then(builder), timeoutMs, () => {
      throw new Error("recompute_timeout");
    });
    return { data, stale: false };
  } catch {
    return { error: "snapshot_unavailable" };
  }
}

const DEFAULT_FILE_RECOMPUTES = Object.freeze({
  overview: null,
  account: recomputeAccount,
  "provider-usage": recomputeProviderUsage,
  providers: recomputeProviders,
});
// Set membership, not `in`: every name here arrives over HTTP, and `in` walks
// the prototype chain ("constructor" would match a plain object map).
const FILE_SECTIONS = new Set(Object.keys(DEFAULT_FILE_RECOMPUTES));

function usageBuilderFor(name) {
  if (name === "chatgpt-usage") {
    return () => buildChatGPTUsageReport(readUsageSnapshotFile(chatGPTUsageSnapshotPath()));
  }
  if (name === "claude-usage") {
    return () =>
      buildClaudeUsageReport({ snapshot: readUsageSnapshotFile(claudeUsageSnapshotPath()) });
  }
  return undefined;
}

export async function getStatusSections(
  names,
  { refresh = false, timeoutMs = INLINE_COMPUTE_TIMEOUT_MS, recomputes = {} } = {},
) {
  const sections = {};
  await Promise.all(
    [...new Set(names)].map(async (name) => {
      try {
        if (FILE_SECTIONS.has(name)) {
          const recompute = Object.hasOwn(recomputes, name)
            ? recomputes[name]
            : DEFAULT_FILE_RECOMPUTES[name];
          sections[name] = await fileSection(name, recompute, { refresh, timeoutMs });
          return;
        }
        const builder = Object.hasOwn(recomputes, name) ? recomputes[name] : usageBuilderFor(name);
        if (!builder) {
          sections[name] = { error: "unknown_section" };
          return;
        }
        sections[name] = await usageSection(builder, { timeoutMs });
      } catch {
        sections[name] = { error: "snapshot_unavailable" };
      }
    }),
  );
  return sections;
}

function invalidRequest(type, message) {
  return { status: 400, body: { error: { type, message } } };
}

export async function handleStatusSnapshotRequest(requestUrl) {
  const raw = requestUrl.searchParams.get("sections") || "";
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return invalidRequest("sections_required", "Query ?sections=<name,...> names the status sections to serve.");
  }
  if (names.length > STATUS_SNAPSHOT_MAX_SECTIONS) {
    return invalidRequest("too_many_sections", "Too many sections requested at once.");
  }
  const unknown = names.filter((name) => !SECTION_SET.has(name));
  if (unknown.length > 0) {
    return invalidRequest(
      "unknown_section",
      `Unknown status section: ${unknown.slice(0, 4).join(", ").slice(0, 80)}.`,
    );
  }
  const refreshParam = requestUrl.searchParams.get("refresh");
  if (refreshParam !== null && refreshParam !== "0" && refreshParam !== "1") {
    return invalidRequest("invalid_refresh", "Query ?refresh= takes 0 or 1.");
  }
  const sections = await getStatusSections(names, { refresh: refreshParam === "1" });
  return { status: 200, body: { ok: true, sections } };
}
