// Short-lived `control` status commands are polled every few seconds by the
// tray, and each poll used to recompute from scratch: `provider-usage` alone
// re-parsed the 250MB+ usage ledger plus a live quota fetch per provider
// (~7s wall, ~1GB peak RSS), and `--probe` re-ran the full vision/local-model
// inventory per target (~7s each). At forty-plus spawns a minute that burns a
// core and churns gigabytes only to re-render slowly-moving numbers.
//
// Cache the exact computed value per command with a short TTL. The bytes
// served are identical to a fresh computation (same object, same print
// formatting); only the recompute cadence changes. `--refresh` bypasses the
// read so explicit refreshes stay fresh. A missing, malformed, oversized, or
// stale entry fails open to a recompute, so the cache can never wedge a
// status surface.
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { writePrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// Quota/usage numbers move slowly; onboarding and profile selection can move
// on user action, so they get shorter windows. The tray polls every couple of
// seconds, so even the shortest TTL serves the vast majority of polls.
export const CONTROL_SNAPSHOT_TTLS_MS = Object.freeze({
  "provider-usage": 90_000,
  // `account` is the selected ChatGPT login's quota, and rewarming it spawns a
  // Codex app-server. At 30 s the tray's poll rewarmed it -- one app-server --
  // nearly every minute, for a weekly percentage that moves a point an hour.
  // The pool's own probe and turn completion keep the table current between.
  account: 5 * 60_000,
  providers: 20_000,
  probe: 60_000,
  // The overview fans out to one probe child per target, so it is the most
  // expensive status read; a minute collapses the tray and turn-completion
  // polls the same way the probe TTL collapses the per-target ones.
  overview: 60_000,
});

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export function controlSnapshotPath(name) {
  if (typeof name !== "string" || !SNAPSHOT_NAME.test(name)) {
    throw new Error(`Invalid control snapshot name: ${String(name)}`);
  }
  return path.join(STATE_DIR, `control-snapshot-${name}.json`);
}

// Same validation as readControlSnapshot without the freshness verdict, so a
// server can report staleness to the caller instead of collapsing it into a
// miss. The caller decides whether stale bytes are acceptable.
export function readControlSnapshotWithMeta(name) {
  try {
    const target = controlSnapshotPath(name);
    if (!existsSync(target)) return undefined;
    if (lstatSync(target).isSymbolicLink()) return undefined;
    const stat = statSync(target);
    if (stat.size > MAX_SNAPSHOT_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return { value: parsed, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

export function readControlSnapshot(name, ttlMs) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  const entry = readControlSnapshotWithMeta(name);
  if (!entry) return undefined;
  if (Date.now() - entry.mtimeMs > ttlMs) return undefined;
  return entry.value;
}

export function writeControlSnapshot(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    writePrivateFile(controlSnapshotPath(name), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
