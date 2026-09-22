import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EngineeringWorktrees,
  assertNoOwnedPathConflicts,
  canonicalOwnedPaths,
  createMemoryWorktreeState,
} from "../src/engineering/worktrees.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-engineering-worktrees-"));
  const repo = path.join(root, "repo");
  const safeRoot = path.join(root, "managed");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "router@example.invalid");
  git(repo, "config", "user.name", "Codex Router Test");
  writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "seed.txt");
  git(repo, "commit", "-q", "-m", "seed");
  return { root, repo, safeRoot, baseOid: git(repo, "rev-parse", "HEAD").trim() };
}

test("owned paths reject escape, repository metadata, symlink, case, and prefix conflicts", () => {
  const { root, repo } = fixture();
  try {
    mkdirSync(path.join(repo, "real"));
    symlinkSync(path.join(repo, "real"), path.join(repo, "linked"), "dir");
    assert.throws(() => canonicalOwnedPaths(repo, ["../escape"]), /Unsafe/u);
    assert.throws(() => canonicalOwnedPaths(repo, [".git/config"]), /Unsafe/u);
    assert.throws(() => canonicalOwnedPaths(repo, ["linked/file"]), /symbolic link/u);
    assert.throws(() => canonicalOwnedPaths(repo, ["Src/A", "src/a"]), /Case-equivalent/u);
    assert.throws(() => assertNoOwnedPathConflicts([
      { taskId: "parent", ownedPaths: ["src"] },
      { taskId: "child", ownedPaths: ["src/file.mjs"] },
    ], { repoRoot: repo }), /ownership conflict/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed worktrees record base provenance, enforce ownership, and clean up only after reconciliation", async () => {
  const { root, repo, safeRoot, baseOid } = fixture();
  try {
    const state = createMemoryWorktreeState();
    const manager = new EngineeringWorktrees({ repoRoot: repo, safeRoot, state });
    const record = await manager.create({
      runId: "run", taskId: "task", attemptId: "attempt", baseRevision: baseOid,
      ownedPaths: ["owned.txt"], ownershipToken: "owner", fence: 7,
    });
    assert.equal(record.lifecycle, "active");
    assert.equal(record.baseOid, baseOid);
    assert.equal(record.detached, true);
    assert.equal(record.branch, null);
    assert.equal(record.fence, 7);
    assert.equal((await manager.inspect(record.worktreeId)).dirty, false);

    writeFileSync(path.join(record.path, "owned.txt"), "result\n");
    git(record.path, "add", "owned.txt");
    git(record.path, "-c", "user.email=router@example.invalid", "-c", "user.name=Router", "commit", "-q", "-m", "result");
    const result = await manager.recordResult(record.worktreeId, {
      ownershipToken: "owner", fence: 7, resultCommit: "HEAD", reconciled: true,
    });
    assert.equal(result.resultRecorded, true);
    assert.equal(result.reconciled, true);
    await assert.rejects(() => manager.cleanup(record.worktreeId, { ownershipToken: "stale", fence: 7 }), /Stale or foreign/u);
    assert.deepEqual(await manager.cleanup(record.worktreeId, { ownershipToken: "owner", fence: 7 }), {
      removed: true,
      worktreeId: record.worktreeId,
    });
    assert.equal(await state.getWorktree(record.worktreeId), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("result recording rejects changes outside assigned ownership and cleanup preserves dirty work", async () => {
  const { root, repo, safeRoot } = fixture();
  try {
    const state = createMemoryWorktreeState();
    const manager = new EngineeringWorktrees({ repoRoot: repo, safeRoot, state });
    const record = await manager.create({
      runId: "run", taskId: "task", attemptId: "attempt", ownedPaths: ["owned.txt"],
      ownershipToken: "owner", fence: 1,
    });
    writeFileSync(path.join(record.path, "outside.txt"), "outside\n");
    git(record.path, "add", "outside.txt");
    git(record.path, "-c", "user.email=router@example.invalid", "-c", "user.name=Router", "commit", "-q", "-m", "outside");
    await assert.rejects(() => manager.recordResult(record.worktreeId, {
      ownershipToken: "owner", fence: 1, resultCommit: "HEAD",
    }), /outside its ownership/u);

    const current = await state.getWorktree(record.worktreeId);
    await state.putWorktree({ ...current, resultRecorded: true, reconciled: true }, { expectedRevision: current.stateRevision });
    writeFileSync(path.join(record.path, "untracked.txt"), "user work\n");
    await assert.rejects(() => manager.cleanup(record.worktreeId, {
      ownershipToken: "owner", fence: 1,
    }), /dirty managed worktree/u);
    assert.equal(readFileSync(path.join(record.path, "untracked.txt"), "utf8"), "user work\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creation state can be reconciled after a crash boundary", async () => {
  const { root, repo, safeRoot } = fixture();
  try {
    const state = createMemoryWorktreeState();
    const manager = new EngineeringWorktrees({ repoRoot: repo, safeRoot, state });
    const record = await manager.create({
      runId: "run", taskId: "task", attemptId: "attempt", ownedPaths: [],
      ownershipToken: "owner", fence: 1,
    });
    const creating = await state.putWorktree(
      { ...record, lifecycle: "creating" },
      { expectedRevision: record.stateRevision },
    );
    const recovered = await manager.reconcile(record.worktreeId);
    assert.equal(recovered.status, "creation_completed");
    assert.equal(recovered.record.lifecycle, "active");
    assert.ok(recovered.record.stateRevision > creating.stateRevision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the integration owner can integrate the selected clean candidate from the same repository", async () => {
  const { root, repo, safeRoot, baseOid } = fixture();
  try {
    const state = createMemoryWorktreeState();
    const manager = new EngineeringWorktrees({
      repoRoot: repo, safeRoot, state, integrationOwner: "integrator",
    });
    const candidate = await manager.create({
      runId: "run", taskId: "candidate", attemptId: "attempt", baseRevision: baseOid,
      ownedPaths: ["chosen.txt"], ownershipToken: "owner", fence: 1,
    });
    writeFileSync(path.join(candidate.path, "chosen.txt"), "winner\n");
    git(candidate.path, "add", "chosen.txt");
    git(candidate.path, "-c", "user.email=router@example.invalid", "-c", "user.name=Router", "commit", "-q", "-m", "candidate");
    const candidateCommit = git(candidate.path, "rev-parse", "HEAD").trim();
    await assert.rejects(() => manager.integrateCandidate({
      taskId: "candidate", integrationPath: repo, expectedHead: baseOid,
      candidateCommit, baseRevision: baseOid, ownedPaths: ["chosen.txt"],
    }), /integration owner/u);
    await assert.rejects(() => manager.integrateCandidate({
      taskId: "integrator", integrationPath: repo, expectedHead: baseOid,
      candidateCommit, baseRevision: baseOid, ownedPaths: ["chosen.txt"],
      selectedCandidateId: "winner", candidateId: "loser",
    }), /selected arena candidate/u);

    const integrated = await manager.integrateCandidate({
      taskId: "integrator", integrationPath: repo, expectedHead: baseOid,
      candidateCommit, baseRevision: baseOid, ownedPaths: ["chosen.txt"],
      selectedCandidateId: "winner", candidateId: "winner",
    });
    assert.equal(integrated.status, "integrated");
    assert.equal(readFileSync(path.join(repo, "chosen.txt"), "utf8"), "winner\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
