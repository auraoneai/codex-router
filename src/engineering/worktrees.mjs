import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function copy(value) {
  return value === undefined ? value : structuredClone(value);
}

async function defaultGit(args, { cwd }) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function physicalDirectory(directory, label) {
  const resolved = path.resolve(directory);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (lstatSync(resolved).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  return realpathSync(resolved);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeLeaf(...parts) {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
  return `worktree-${digest}`;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    throw new Error(`Owned path must be a non-empty repository-relative path: ${value}`);
  }
  const slash = value.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  const normalized = path.posix.normalize(slash);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("-") ||
    normalized.includes("\0") ||
    normalized.toLocaleLowerCase("en-US") === ".git" ||
    normalized.toLocaleLowerCase("en-US").startsWith(".git/")
  ) {
    throw new Error(`Unsafe owned path: ${value}`);
  }
  return normalized;
}

function rejectSymlinkTraversal(repoRoot, relativePath) {
  let cursor = repoRoot;
  for (const segment of relativePath.split("/")) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Owned path traverses a symbolic link: ${relativePath}`);
    }
  }
}

export function canonicalOwnedPaths(repoRoot, ownedPaths) {
  const root = realpathSync(path.resolve(repoRoot));
  const seen = new Set();
  return (ownedPaths || []).map((value) => {
    const normalized = normalizeRelativePath(value);
    rejectSymlinkTraversal(root, normalized);
    const folded = normalized.toLocaleLowerCase("en-US");
    if (seen.has(folded)) throw new Error(`Case-equivalent owned path appears twice: ${value}`);
    seen.add(folded);
    return { path: normalized, folded };
  }).sort((a, b) => a.folded.localeCompare(b.folded));
}

export function assertNoOwnedPathConflicts(assignments, { repoRoot }) {
  const claims = [];
  for (const assignment of assignments) {
    for (const owned of canonicalOwnedPaths(repoRoot, assignment.ownedPaths)) {
      const conflict = claims.find((claim) =>
        owned.folded === claim.folded ||
        owned.folded.startsWith(`${claim.folded}/`) ||
        claim.folded.startsWith(`${owned.folded}/`));
      if (conflict) {
        throw new Error(
          `Writable ownership conflict: ${assignment.taskId} ${owned.path} overlaps ${conflict.taskId} ${conflict.path}.`,
        );
      }
      claims.push({ ...owned, taskId: assignment.taskId });
    }
  }
  return true;
}

export function createMemoryWorktreeState() {
  const records = new Map();
  return {
    async putWorktree(record, { expectedRevision } = {}) {
      const current = records.get(record.worktreeId);
      const revision = current?.stateRevision || 0;
      if (expectedRevision !== undefined && revision !== expectedRevision) {
        throw new Error(`Worktree ${record.worktreeId} revision conflict: expected ${expectedRevision}, found ${revision}.`);
      }
      const next = { ...copy(record), stateRevision: revision + 1 };
      records.set(record.worktreeId, next);
      return copy(next);
    },
    async getWorktree(worktreeId) {
      return copy(records.get(worktreeId));
    },
    async deleteWorktree(worktreeId, { expectedRevision } = {}) {
      const current = records.get(worktreeId);
      if (expectedRevision !== undefined && current?.stateRevision !== expectedRevision) {
        throw new Error(`Worktree ${worktreeId} revision conflict during deletion.`);
      }
      records.delete(worktreeId);
    },
    async listWorktrees() {
      return [...records.values()].map(copy);
    },
  };
}

function parseRegisteredWorktrees(output) {
  const text = String(output || "");
  // `-z` is the unambiguous format and is what current Git emits. Keep the
  // line-oriented fallback for Git for Windows builds that ignore `-z` when
  // it is combined with `--porcelain`.
  const fields = text.includes("\0") ? text.split("\0") : text.split(/\r?\n/u);
  return fields
    .filter(Boolean)
    .filter((field) => field.startsWith("worktree "))
    .map((field) => {
      let worktreePath = field.slice("worktree ".length);
      // Some MSYS-facing Git builds render a native drive path as /C:/... .
      // Node's win32 path resolver treats that spelling as rooted on the
      // current drive, so convert it back before resolving it.
      if (process.platform === "win32" && /^\/[a-z]:[\\/]/iu.test(worktreePath)) {
        worktreePath = worktreePath.slice(1);
      }
      return path.resolve(worktreePath);
    });
}

function sameFilesystemPath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);

  // Git for Windows can report an expanded long path while Node retains an
  // 8.3 component from os.tmpdir(). Compare the directory identities before
  // comparing their spellings so those aliases still prove registration.
  const leftStat = statSync(resolvedLeft, { bigint: true });
  const rightStat = statSync(resolvedRight, { bigint: true });
  if (leftStat.ino !== 0n && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
    return true;
  }

  const normalize = (value) => {
    const resolved = realpathSync.native(path.resolve(value))
      .replace(/^\\\\\?\\/u, "")
      .replaceAll("\\", "/");
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(resolvedLeft) === normalize(resolvedRight);
}

function isOwnedChange(file, ownedPaths) {
  const folded = file.normalize("NFC").replaceAll("\\", "/").toLocaleLowerCase("en-US");
  return ownedPaths.some((owned) => folded === owned.folded || folded.startsWith(`${owned.folded}/`));
}

export class EngineeringWorktrees {
  constructor({ repoRoot, safeRoot, state, runGit = defaultGit, integrationOwner, withIntegrationLock }) {
    if (!repoRoot || !safeRoot || !state) throw new Error("repoRoot, safeRoot, and state are required.");
    this.repoRoot = realpathSync(path.resolve(repoRoot));
    this.safeRoot = physicalDirectory(safeRoot, "Managed worktree root");
    if (this.safeRoot === this.repoRoot || contained(this.repoRoot, this.safeRoot)) {
      throw new Error("Managed worktree root must be outside the repository checkout.");
    }
    this.state = state;
    this.runGit = runGit;
    this.integrationOwner = integrationOwner || null;
    let integrationQueue = Promise.resolve();
    this.withIntegrationLock = withIntegrationLock || (async (operation) => {
      const predecessor = integrationQueue;
      let release;
      integrationQueue = new Promise((resolve) => { release = resolve; });
      await predecessor;
      try {
        return await operation();
      } finally {
        release();
      }
    });
    for (const method of ["putWorktree", "getWorktree", "deleteWorktree", "listWorktrees"]) {
      if (typeof state[method] !== "function") throw new Error(`Worktree state adapter is missing ${method}().`);
    }
  }

  async create({ runId, taskId, attemptId, baseRevision = "HEAD", ownedPaths = [], ownershipToken = randomUUID(), fence = 1 }) {
    if (![runId, taskId, attemptId].every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error("runId, taskId, and attemptId are required.");
    }
    if (!Number.isSafeInteger(fence) || fence <= 0) throw new Error("A positive fencing token is required.");
    const canonical = canonicalOwnedPaths(this.repoRoot, ownedPaths);
    const baseOid = String(await this.runGit(["rev-parse", "--verify", `${baseRevision}^{commit}`], { cwd: this.repoRoot })).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseOid)) throw new Error("Git did not resolve the base to a commit OID.");
    const worktreeId = safeLeaf(runId, taskId, attemptId);
    const worktreePath = path.join(this.safeRoot, worktreeId);
    if (!contained(this.safeRoot, worktreePath) || existsSync(worktreePath)) {
      throw new Error(`Managed worktree path is unsafe or already exists: ${worktreePath}`);
    }
    let record = {
      version: 1,
      kind: "router-managed",
      worktreeId,
      runId,
      taskId,
      attemptId,
      repoRoot: this.repoRoot,
      path: worktreePath,
      baseOid,
      branch: null,
      detached: true,
      ownedPaths: canonical,
      ownershipToken,
      fence,
      lifecycle: "creating",
      resultRecorded: false,
      reconciled: false,
    };
    record = await this.state.putWorktree(record, { expectedRevision: 0 });
    try {
      await this.runGit(["worktree", "add", "--detach", worktreePath, baseOid], { cwd: this.repoRoot });
      record = await this.state.putWorktree({ ...record, lifecycle: "active" }, { expectedRevision: record.stateRevision });
    } catch (cause) {
      if (existsSync(worktreePath)) {
        await this.runGit(["worktree", "remove", "--force", worktreePath], { cwd: this.repoRoot }).catch(() => {});
      }
      await this.state.deleteWorktree(worktreeId, { expectedRevision: record.stateRevision }).catch(() => {});
      throw cause;
    }
    return copy(record);
  }

  async inspect(worktreeId) {
    const record = await this.state.getWorktree(worktreeId);
    if (!record) throw new Error(`Unknown managed worktree ${worktreeId}.`);
    if (record.kind !== "router-managed") {
      return { ...record, cleanupAllowed: false, cleanupReason: "host-managed" };
    }
    if (record.lifecycle !== "active" && record.lifecycle !== "cleanup_pending") {
      throw new Error(`Managed worktree ${worktreeId} is not active.`);
    }
    this.#validateRecordPath(record);
    const [head, status] = await Promise.all([
      this.runGit(["rev-parse", "HEAD"], { cwd: record.path }),
      this.runGit(["status", "--porcelain=v2", "-z"], { cwd: record.path }),
    ]);
    return {
      ...record,
      headOid: String(head).trim(),
      dirty: String(status).length > 0,
      dirtyStatus: String(status),
    };
  }

  async recordResult(worktreeId, { ownershipToken, fence, resultCommit, reconciled = true }) {
    const record = await this.#ownedRecord(worktreeId, ownershipToken, fence);
    if (record.lifecycle !== "active") throw new Error("A worktree being cleaned up cannot record a new result.");
    const commit = String(await this.runGit(["rev-parse", "--verify", `${resultCommit || "HEAD"}^{commit}`], { cwd: record.path })).trim();
    await this.runGit(["merge-base", "--is-ancestor", record.baseOid, commit], { cwd: record.path });
    const changes = String(await this.runGit([
      "diff", "--name-only", "-z", `${record.baseOid}..${commit}`, "--",
    ], { cwd: record.path })).split("\0").filter(Boolean);
    const outside = changes.filter((file) => !isOwnedChange(file, record.ownedPaths));
    if (outside.length) throw new Error(`Worktree result changed paths outside its ownership: ${outside.join(", ")}`);
    const next = { ...record, resultCommit: commit, resultRecorded: true, reconciled: Boolean(reconciled) };
    return this.state.putWorktree(next, { expectedRevision: record.stateRevision });
  }

  async cleanup(worktreeId, { ownershipToken, fence }) {
    const record = await this.#ownedRecord(worktreeId, ownershipToken, fence);
    if (record.kind !== "router-managed") throw new Error("Host-managed worktrees are never removed by the Router.");
    if (!record.resultRecorded || !record.reconciled) throw new Error("Worktree result must be durably recorded and reconciled before cleanup.");
    const inspected = await this.inspect(worktreeId);
    if (inspected.dirty) throw new Error("Refusing to remove a dirty managed worktree.");
    const registered = parseRegisteredWorktrees(
      await this.runGit(["worktree", "list", "--porcelain", "-z"], { cwd: this.repoRoot }),
    );
    if (!registered.some((entry) => sameFilesystemPath(entry, record.path))) {
      throw new Error("Refusing to remove an unregistered or path-mismatched worktree.");
    }
    // Repeat ownership/path checks at the destructive boundary.
    await this.#ownedRecord(worktreeId, ownershipToken, fence);
    this.#validateRecordPath(record);
    const pending = await this.state.putWorktree(
      { ...record, lifecycle: "cleanup_pending" },
      { expectedRevision: record.stateRevision },
    );
    await this.runGit(["worktree", "remove", record.path], { cwd: this.repoRoot });
    await this.state.deleteWorktree(worktreeId, { expectedRevision: pending.stateRevision });
    return { removed: true, worktreeId };
  }

  async reconcile(worktreeId) {
    const record = await this.state.getWorktree(worktreeId);
    if (!record) return { status: "absent", worktreeId };
    if (record.kind !== "router-managed") return { status: "host_managed", record };
    const present = existsSync(record.path);
    if (record.lifecycle === "cleanup_pending" && !present) {
      await this.state.deleteWorktree(worktreeId, { expectedRevision: record.stateRevision });
      return { status: "cleanup_completed", worktreeId };
    }
    if (record.lifecycle === "creating" && !present) {
      await this.state.deleteWorktree(worktreeId, { expectedRevision: record.stateRevision });
      return { status: "creation_abandoned", worktreeId };
    }
    if (record.lifecycle === "creating" && present) {
      this.#validateRecordPath(record);
      const registered = parseRegisteredWorktrees(
        await this.runGit(["worktree", "list", "--porcelain", "-z"], { cwd: this.repoRoot }),
      );
      if (!registered.some((entry) => sameFilesystemPath(entry, record.path))) {
        throw new Error("A creating worktree exists but is not registered with the repository.");
      }
      const head = String(await this.runGit(["rev-parse", "HEAD"], { cwd: record.path })).trim();
      if (head !== record.baseOid) throw new Error("A creating worktree moved away from its recorded base revision.");
      const active = await this.state.putWorktree(
        { ...record, lifecycle: "active" },
        { expectedRevision: record.stateRevision },
      );
      return { status: "creation_completed", record: active };
    }
    return { status: record.lifecycle, record: await this.inspect(worktreeId) };
  }

  async integrateCandidate({
    taskId,
    integrationPath,
    expectedHead,
    candidateCommit,
    baseRevision,
    ownedPaths,
    selectedCandidateId,
    candidateId,
  }) {
    if (taskId !== this.integrationOwner) throw new Error("Only the configured integration owner may mutate the integration worktree.");
    if (selectedCandidateId && selectedCandidateId !== candidateId) throw new Error("Only the selected arena candidate may be integrated.");
    const integrationRoot = realpathSync(path.resolve(integrationPath));
    return this.withIntegrationLock(async () => {
      const [repoCommonRaw, integrationCommonRaw, dirty] = await Promise.all([
        this.runGit(["rev-parse", "--git-common-dir"], { cwd: this.repoRoot }),
        this.runGit(["rev-parse", "--git-common-dir"], { cwd: integrationRoot }),
        this.runGit(["status", "--porcelain=v2", "-z"], { cwd: integrationRoot }),
      ]);
      const resolveGitPath = (root, value) => realpathSync(path.resolve(root, String(value).trim()));
      if (resolveGitPath(this.repoRoot, repoCommonRaw) !== resolveGitPath(integrationRoot, integrationCommonRaw)) {
        throw new Error("Integration checkout does not belong to the managed repository.");
      }
      if (String(dirty).length > 0) throw new Error("Refusing to integrate into a dirty checkout.");
      const head = String(await this.runGit(["rev-parse", "HEAD"], { cwd: integrationRoot })).trim();
      if (head !== expectedHead) throw new Error(`Integration head moved: expected ${expectedHead}, found ${head}.`);
      await this.runGit(["merge-base", "--is-ancestor", baseRevision, candidateCommit], { cwd: integrationRoot });
      const changes = String(await this.runGit([
        "diff", "--name-only", "-z", `${baseRevision}..${candidateCommit}`, "--",
      ], { cwd: integrationRoot })).split("\0").filter(Boolean);
      const canonical = canonicalOwnedPaths(this.repoRoot, ownedPaths);
      const outside = changes.filter((file) => !isOwnedChange(file, canonical));
      if (outside.length) throw new Error(`Candidate changed paths outside its ownership: ${outside.join(", ")}`);
      try {
        await this.runGit(["cherry-pick", candidateCommit], { cwd: integrationRoot });
      } catch (cause) {
        let conflicts = "";
        try {
          conflicts = String(await this.runGit(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: integrationRoot }));
        } finally {
          await this.runGit(["cherry-pick", "--abort"], { cwd: integrationRoot }).catch(() => {});
        }
        return {
          status: "needs_remediation",
          conflicts: conflicts.split("\0").filter(Boolean),
          priorHead: head,
          error: String(cause?.message || cause),
        };
      }
      const integratedHead = String(await this.runGit(["rev-parse", "HEAD"], { cwd: integrationRoot })).trim();
      return { status: "integrated", priorHead: head, revision: integratedHead, changedPaths: changes };
    });
  }

  #validateRecordPath(record) {
    const resolved = path.resolve(record.path);
    if (!contained(this.safeRoot, resolved) || path.basename(resolved) !== record.worktreeId) {
      throw new Error("Managed worktree record escapes its safe root.");
    }
    if (!existsSync(resolved)) throw new Error("Managed worktree path no longer exists.");
    if (lstatSync(resolved).isSymbolicLink() || realpathSync(resolved) !== resolved) {
      throw new Error("Managed worktree path is a symbolic link or changed identity.");
    }
  }

  async #ownedRecord(worktreeId, ownershipToken, fence) {
    const record = await this.state.getWorktree(worktreeId);
    if (!record) throw new Error(`Unknown managed worktree ${worktreeId}.`);
    if (record.ownershipToken !== ownershipToken || record.fence !== fence) {
      throw new Error("Stale or foreign worktree ownership token.");
    }
    if (record.lifecycle !== "active" && record.lifecycle !== "cleanup_pending") {
      throw new Error(`Managed worktree ${worktreeId} is not active.`);
    }
    if (record.kind === "router-managed") this.#validateRecordPath(record);
    return record;
  }
}
