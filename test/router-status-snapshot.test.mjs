import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-status-snapshot-"));
const codexHome = mkdtempSync(path.join(os.tmpdir(), "router-status-snapshot-home-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = codexHome;

const {
  getStatusSections,
  handleStatusSnapshotRequest,
  STATUS_SNAPSHOT_SECTIONS,
} = await import("../src/router-status-snapshot.mjs");
const {
  CONTROL_SNAPSHOT_TTLS_MS,
  controlSnapshotPath,
  writeControlSnapshot,
} = await import("../src/control-snapshot-cache.mjs");

function request(query) {
  return new URL(`http://127.0.0.1:4202/v1/status/snapshot${query}`);
}

function ageSnapshot(name, ttlMs) {
  const ancient = new Date(Date.now() - ttlMs - 60_000);
  utimesSync(controlSnapshotPath(name), ancient, ancient);
}

async function settleBackgroundCalls(counter, deadlineMs = 5_000) {
  const deadline = Date.now() + deadlineMs;
  while (counter.calls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("rejects requests without sections", async () => {
  const { status, body } = await handleStatusSnapshotRequest(request(""));
  assert.equal(status, 400);
  assert.equal(body.error.type, "sections_required");
});

test("rejects unknown sections without echoing unbounded input", async () => {
  const { status, body } = await handleStatusSnapshotRequest(request("?sections=bogus"));
  assert.equal(status, 400);
  assert.equal(body.error.type, "unknown_section");
  const capped = await handleStatusSnapshotRequest(request(`?sections=${"x".repeat(500)}`));
  assert.equal(capped.status, 400);
  assert.ok(capped.body.error.message.length <= 120);
});

test("rejects too many sections and bad refresh flags", async () => {
  const many = [...STATUS_SNAPSHOT_SECTIONS, "bogus"].join(",");
  const over = await handleStatusSnapshotRequest(request(`?sections=${many}`));
  assert.equal(over.status, 400);
  assert.equal(over.body.error.type, "too_many_sections");
  const bad = await handleStatusSnapshotRequest(request("?sections=account&refresh=yes"));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.type, "invalid_refresh");
});

test("serves a fresh file section without recomputing", async () => {
  let calls = 0;
  assert.equal(writeControlSnapshot("providers", { hello: "world" }), true);
  const sections = await getStatusSections(["providers"], {
    recomputes: {
      providers: async () => {
        calls += 1;
        return { fresh: true };
      },
    },
  });
  assert.deepEqual(sections.providers, { data: { hello: "world" }, stale: false });
  assert.equal(calls, 0);
});

test("serves stale bytes while a background refresh rewarm the file", async () => {
  assert.equal(writeControlSnapshot("providers", { old: true }), true);
  ageSnapshot("providers", CONTROL_SNAPSHOT_TTLS_MS.providers);
  const counter = { calls: 0 };
  const sections = await getStatusSections(["providers"], {
    recomputes: {
      providers: async () => {
        counter.calls += 1;
        writeControlSnapshot("providers", { old: false });
        return { old: false };
      },
    },
  });
  assert.deepEqual(sections.providers, { data: { old: true }, stale: true });
  await settleBackgroundCalls(counter);
  assert.equal(counter.calls, 1);
});

test("collapses concurrent stale reads into one recompute", async () => {
  assert.equal(writeControlSnapshot("account", { old: true }), true);
  ageSnapshot("account", CONTROL_SNAPSHOT_TTLS_MS.account);
  let calls = 0;
  const recompute = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { fresh: true };
  };
  const [first, second] = await Promise.all([
    getStatusSections(["account"], { recomputes: { account: recompute } }),
    getStatusSections(["account"], { recomputes: { account: recompute } }),
  ]);
  assert.equal(first.account.stale, true);
  assert.equal(second.account.stale, true);
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
});

test("computes inline when the file is missing", async () => {
  rmSync(controlSnapshotPath("account"), { force: true });
  const sections = await getStatusSections(["account"], {
    recomputes: { account: async () => ({ computed: true }) },
  });
  assert.deepEqual(sections.account, { data: { computed: true }, stale: false });
});

test("a failed inline compute surfaces an error entry", async () => {
  rmSync(controlSnapshotPath("account"), { force: true });
  const sections = await getStatusSections(["account"], {
    recomputes: {
      account: async () => {
        throw new Error("boom");
      },
    },
  });
  assert.deepEqual(sections.account, { error: "snapshot_unavailable" });
});

test("a slow inline compute times out instead of blocking the poll", async () => {
  rmSync(controlSnapshotPath("providers"), { force: true });
  const sections = await getStatusSections(["providers"], {
    timeoutMs: 25,
    recomputes: {
      providers: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {};
      },
    },
  });
  assert.deepEqual(sections.providers, { error: "snapshot_unavailable" });
});

test("serves the overview file and flags staleness without recomputing", async () => {
  assert.equal(writeControlSnapshot("overview", { targets: {} }), true);
  const fresh = await getStatusSections(["overview"]);
  assert.deepEqual(fresh.overview, { data: { targets: {} }, stale: false });
  ageSnapshot("overview", CONTROL_SNAPSHOT_TTLS_MS.overview);
  const stale = await getStatusSections(["overview"]);
  assert.deepEqual(stale.overview, { data: { targets: {} }, stale: true });
});

test("a missing overview reports unavailable", async () => {
  rmSync(controlSnapshotPath("overview"), { force: true });
  const sections = await getStatusSections(["overview"]);
  assert.deepEqual(sections.overview, { error: "snapshot_unavailable" });
});

test("unknown sections fail closed per section", async () => {
  const sections = await getStatusSections(["constructor"]);
  assert.deepEqual(sections.constructor, { error: "unknown_section" });
});

test("usage sections build inline and isolate failures per section", async () => {
  const sections = await getStatusSections(["chatgpt-usage", "claude-usage"], {
    recomputes: {
      "chatgpt-usage": async () => ({ rotation: [] }),
      "claude-usage": async () => {
        throw new Error("boom");
      },
    },
  });
  assert.deepEqual(sections["chatgpt-usage"], { data: { rotation: [] }, stale: false });
  assert.deepEqual(sections["claude-usage"], { error: "snapshot_unavailable" });
});
