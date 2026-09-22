import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { privateFileIsProtected } from "../src/file-security.mjs";
import {
  acceptEngineeringTask,
  claimEngineeringTaskLease,
  createEngineeringTask,
  readEngineeringState,
  releaseEngineeringTaskLease,
  transitionEngineeringTask,
} from "../src/engineering/state.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-engineering-state-"));
  return { root, target: path.join(root, "private", "engineering.json") };
}

test("engineering state is atomically persisted owner-only and advances by CAS", () => {
  const { root, target } = fixture();
  try {
    const created = createEngineeringTask(target, { id: "task-1", objective: "change one file", revision: "rev-a" });
    assert.equal(created.state.version, 1);
    assert.equal(created.result.state, "planned");
    assert.equal(privateFileIsProtected(target), true);
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(target, "utf8")).tasks["task-1"].objective, "change one file");

    const claimed = claimEngineeringTaskLease(target, {
      taskId: "task-1",
      owner: "scheduler-1",
      expectedStoreVersion: 1,
      expectedTaskVersion: 1,
    });
    assert.match(claimed.result.token, /^lease_1_/u);
    assert.equal(claimed.state.version, 2);
    assert.equal(claimed.state.tasks["task-1"].version, 2);

    const ready = transitionEngineeringTask(target, {
      taskId: "task-1",
      to: "ready",
      reason: "dependencies satisfied",
      fenceToken: claimed.result.token,
      expectedStoreVersion: 2,
      expectedTaskVersion: 2,
    });
    assert.equal(ready.result.state, "ready");
    assert.equal(ready.result.transitions.at(-1).reason, "dependencies satisfied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state creation accepts versioned EngineeringTask identity and base revision fields", () => {
  const { root, target } = fixture();
  try {
    const created = createEngineeringTask(target, {
      version: 1,
      type: "EngineeringTask",
      taskId: "contract-task",
      baseRevision: "base-rev",
    });
    assert.equal(created.result.id, "contract-task");
    assert.equal(created.result.taskId, "contract-task");
    assert.equal(created.result.revision, "base-rev");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state rejects stale versions, stale fences, and illegal transitions without mutation", () => {
  const { root, target } = fixture();
  try {
    createEngineeringTask(target, { id: "task-1", revision: "rev-a" });
    const claimed = claimEngineeringTaskLease(target, {
      taskId: "task-1",
      owner: "scheduler-1",
      expectedStoreVersion: 1,
      expectedTaskVersion: 1,
    });
    const before = readFileSync(target, "utf8");
    assert.throws(() => transitionEngineeringTask(target, {
      taskId: "task-1",
      to: "ready",
      reason: "stale writer",
      fenceToken: claimed.result.token,
      expectedStoreVersion: 1,
      expectedTaskVersion: 2,
    }), /version conflict/u);
    assert.throws(() => transitionEngineeringTask(target, {
      taskId: "task-1",
      to: "ready",
      reason: "wrong lease",
      fenceToken: "lease_0_stale",
      expectedStoreVersion: 2,
      expectedTaskVersion: 2,
    }), /stale or missing fencing token/u);
    assert.throws(() => transitionEngineeringTask(target, {
      taskId: "task-1",
      to: "running",
      reason: "skip assignment",
      fenceToken: claimed.result.token,
      expectedStoreVersion: 2,
      expectedTaskVersion: 2,
    }), /Illegal engineering task transition/u);
    assert.equal(readFileSync(target, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state transitions require an active lease", () => {
  const { root, target } = fixture();
  try {
    createEngineeringTask(target, { id: "task-1", revision: "rev-a" });
    const before = readFileSync(target, "utf8");
    assert.throws(() => transitionEngineeringTask(target, {
      taskId: "task-1",
      to: "ready",
      reason: "unfenced writer",
      expectedStoreVersion: 1,
      expectedTaskVersion: 1,
    }), /no active lease/u);
    assert.equal(readFileSync(target, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("released leases are fenced from later owners", () => {
  const { root, target } = fixture();
  try {
    createEngineeringTask(target, { id: "task-1" });
    const first = claimEngineeringTaskLease(target, {
      taskId: "task-1", owner: "first", expectedStoreVersion: 1, expectedTaskVersion: 1,
    });
    releaseEngineeringTaskLease(target, {
      taskId: "task-1", fenceToken: first.result.token, expectedStoreVersion: 2, expectedTaskVersion: 2,
    });
    const second = claimEngineeringTaskLease(target, {
      taskId: "task-1", owner: "second", expectedStoreVersion: 3, expectedTaskVersion: 3,
    });
    assert.notEqual(second.result.token, first.result.token);
    assert.equal(second.result.sequence, 2);
    assert.throws(() => transitionEngineeringTask(target, {
      taskId: "task-1",
      to: "ready",
      reason: "late first owner",
      fenceToken: first.result.token,
      expectedStoreVersion: 4,
      expectedTaskVersion: 4,
    }), /stale or missing fencing token/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only a passing revision-bound runtime decision can accept a task", () => {
  const { root, target } = fixture();
  try {
    createEngineeringTask(target, { id: "task-1", revision: "rev-a" });
    const lease = claimEngineeringTaskLease(target, {
      taskId: "task-1", owner: "scheduler", expectedStoreVersion: 1, expectedTaskVersion: 1,
    }).result.token;
    const steps = [
      ["ready", "ready"],
      ["assigned", "assigned"],
      ["running", "running"],
      ["result_recorded", "result recorded"],
      ["verifying", "checks dispatched"],
    ];
    let storeVersion = 2;
    let taskVersion = 2;
    for (const [to, reason] of steps) {
      transitionEngineeringTask(target, {
        taskId: "task-1", to, reason, fenceToken: lease,
        expectedStoreVersion: storeVersion, expectedTaskVersion: taskVersion,
      });
      storeVersion += 1;
      taskVersion += 1;
    }
    assert.throws(() => transitionEngineeringTask(target, {
      taskId: "task-1", to: "accepted", reason: "worker says pass", fenceToken: lease,
      expectedStoreVersion: storeVersion, expectedTaskVersion: taskVersion,
    }), /acceptEngineeringTask/u);
    assert.throws(() => acceptEngineeringTask(target, {
      taskId: "task-1",
      acceptance: {
        accepted: true,
        revision: "rev-old",
        gates: { verification: true, review: true },
        blockers: [],
      },
      fenceToken: lease,
      expectedStoreVersion: storeVersion, expectedTaskVersion: taskVersion,
    }), /acceptance revision/u);
    const accepted = acceptEngineeringTask(target, {
      taskId: "task-1",
      acceptance: {
        accepted: true,
        revision: "rev-a",
        gates: { verification: true, review: true },
        blockers: [],
      },
      fenceToken: lease,
      expectedStoreVersion: storeVersion,
      expectedTaskVersion: taskVersion,
    });
    assert.equal(accepted.result.state, "accepted");
    assert.throws(() => claimEngineeringTaskLease(target, {
      taskId: "task-1",
      owner: "late scheduler",
      expectedStoreVersion: accepted.state.version,
      expectedTaskVersion: accepted.result.version,
    }), /terminal and cannot be leased/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state validation refuses an accepted task whose runtime proof was removed", () => {
  const { root, target } = fixture();
  try {
    createEngineeringTask(target, { id: "task-1", revision: "rev-a" });
    const lease = claimEngineeringTaskLease(target, {
      taskId: "task-1", owner: "scheduler", expectedStoreVersion: 1, expectedTaskVersion: 1,
    }).result.token;
    let storeVersion = 2;
    let taskVersion = 2;
    for (const to of ["ready", "assigned", "running", "result_recorded", "verifying"]) {
      transitionEngineeringTask(target, {
        taskId: "task-1", to, reason: `advance to ${to}`, fenceToken: lease,
        expectedStoreVersion: storeVersion, expectedTaskVersion: taskVersion,
      });
      storeVersion += 1;
      taskVersion += 1;
    }
    acceptEngineeringTask(target, {
      taskId: "task-1",
      acceptance: {
        accepted: true,
        revision: "rev-a",
        gates: { immutableRevision: true, verification: true, review: true },
        blockers: [],
      },
      fenceToken: lease,
      expectedStoreVersion: storeVersion,
      expectedTaskVersion: taskVersion,
    });
    const forged = JSON.parse(readFileSync(target, "utf8"));
    delete forged.tasks["task-1"].acceptance;
    writeFileSync(target, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    assert.throws(() => readEngineeringState(target), /accepted without a passing runtime acceptance result/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state reader refuses unprotected state", { skip: process.platform === "win32" }, () => {
  const { root, target } = fixture();
  try {
    createEngineeringTask(target, { id: "task-1" });
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o600);
    // eslint-free repository tests use the fs API directly for this isolated fixture.
    const { chmodSync } = awaitImportFs();
    chmodSync(target, 0o644);
    assert.throws(() => readEngineeringState(target), /not owner-only/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function awaitImportFs() {
  // Kept as a helper so the test's mutation is visibly limited to its fixture.
  return { chmodSync: (target, mode) => {
    const current = process.getBuiltinModule("node:fs");
    current.chmodSync(target, mode);
  } };
}
