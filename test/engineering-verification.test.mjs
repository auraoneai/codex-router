import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DeterministicVerificationRunner,
  createGitSourceIdentityProvider,
  createSpawnProcessRunner,
  redactVerificationArguments,
  VERIFICATION_IDENTITY_CHANGED_EXIT_CODE,
  VERIFICATION_NOT_RUN_EXIT_CODE,
  verificationResultPassed,
} from "../src/engineering/verification.mjs";

function tickingClock() {
  let milliseconds = Date.parse("2026-09-22T00:00:00.000Z");
  return () => new Date(milliseconds++);
}

async function withArtifactRoot(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "router-verification-"));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("verification runs argv in configured order, redacts secrets, and records immutable artifacts", async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const calls = [];
    const runner = new DeterministicVerificationRunner({
      artifactRoot,
      clock: tickingClock(),
      host: "remote-runner",
      sourceIdentity: async () => ({ sourceRevision: "rev-1", dirtyTreeDigest: "dirty-1" }),
      processRunner: async (request) => {
        calls.push(request);
        return request.command === "unit"
          ? { exitCode: 0, timedOut: false, stdout: "12 passing", stderr: "", testCount: 12 }
          : { exitCode: 2, timedOut: false, stdout: "", stderr: "lint failed", testCount: 1 };
      },
    });
    const results = await runner.runPlan([
      { id: "unit", command: "unit", args: ["--token", "secret-value"], cwd: "/repo" },
      { id: "lint", command: "lint", args: [], cwd: "/repo" },
      { id: "integration", command: "integration", args: [], cwd: "/repo" },
    ], {
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      expectedIdentity: { sourceRevision: "rev-1", dirtyTreeDigest: "dirty-1" },
    });

    assert.deepEqual(calls.map((call) => call.command), ["unit", "lint"]);
    assert.deepEqual(results.map((result) => result.exitCode), [0, 2, VERIFICATION_NOT_RUN_EXIT_CODE]);
    assert.deepEqual(results[0].arguments, ["--token", "[REDACTED]"]);
    assert.equal(results[0].sourceRevision, "rev-1");
    assert.equal(results[0].dirtyTreeDigest, "dirty-1");
    assert.equal(results[0].host, "remote-runner");
    assert.equal(results[0].testCount, 12);
    assert.equal(verificationResultPassed(results[0]), true);
    assert.equal(verificationResultPassed(results[1]), false);
    assert.ok(Object.isFrozen(results[0]));
    const firstArtifact = JSON.parse(await readFile(path.join(artifactRoot, results[0].artifactLocation), "utf8"));
    assert.equal(firstArtifact.stdout, "12 passing");
    assert.deepEqual(firstArtifact.arguments, ["--token", "[REDACTED]"]);
    const skippedArtifact = JSON.parse(await readFile(path.join(artifactRoot, results[2].artifactLocation), "utf8"));
    assert.equal(skippedArtifact.outcome, "not_run");
    assert.match(skippedArtifact.reason, /lint failed/u);
  });
});

test("source mutation during a gate invalidates an otherwise successful command", async () => {
  await withArtifactRoot(async (artifactRoot) => {
    let observation = 0;
    const runner = new DeterministicVerificationRunner({
      artifactRoot,
      clock: tickingClock(),
      sourceIdentity: async () => observation++ === 0
        ? { sourceRevision: "rev-1", dirtyTreeDigest: "tree-a" }
        : { sourceRevision: "rev-1", dirtyTreeDigest: "tree-b" },
      processRunner: async () => ({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
    });
    const result = await runner.runGate({ id: "unit", command: "node", args: ["test.mjs"], cwd: "/repo" }, {
      runId: "run",
      taskId: "task",
      expectedIdentity: { sourceRevision: "rev-1", dirtyTreeDigest: "tree-a" },
    });
    assert.equal(result.exitCode, VERIFICATION_IDENTITY_CHANGED_EXIT_CODE);
    assert.equal(verificationResultPassed(result), false);
    const artifact = JSON.parse(await readFile(path.join(artifactRoot, result.artifactLocation), "utf8"));
    assert.equal(artifact.outcome, "source_changed");
  });
});

test("disabled gates, timeouts, signals, and spawn errors are explicit failures", async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const outcomes = [
      { timedOut: true, signal: "SIGTERM", stdout: "", stderr: "deadline" },
      new Error("spawn refused"),
    ];
    const runner = new DeterministicVerificationRunner({
      artifactRoot,
      clock: tickingClock(),
      sourceIdentity: async () => ({ sourceRevision: "rev-1" }),
      processRunner: async () => {
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    });
    const disabled = await runner.runGate({ id: "disabled", command: "unit", cwd: "/repo", enabled: false }, {
      runId: "run", taskId: "task",
    });
    const timeout = await runner.runGate({ id: "timeout", command: "unit", cwd: "/repo" }, {
      runId: "run", taskId: "task",
    });
    const spawnError = await runner.runGate({ id: "spawn", command: "missing", cwd: "/repo" }, {
      runId: "run", taskId: "task",
    });
    assert.equal(disabled.exitCode, VERIFICATION_NOT_RUN_EXIT_CODE);
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.signal, "SIGTERM");
    assert.equal(spawnError.exitCode, 127);
    assert.equal([disabled, timeout, spawnError].every((result) => !verificationResultPassed(result)), true);
  });
});

test("argument redaction covers separate values and assignments without changing ordinary argv", () => {
  assert.deepEqual(redactVerificationArguments([
    "--api-key=one", "--token", "two", "--flag", "ordinary", "PASSWORD=three", "Authorization: Bearer four",
  ]), [
    "--api-key=[REDACTED]", "--token", "[REDACTED]", "--flag", "ordinary", "PASSWORD=[REDACTED]", "Authorization: [REDACTED]",
  ]);
});

test("dirty checkout source identities include HEAD plus tracked and untracked bytes", async () => {
  const checkout = await mkdtemp(path.join(tmpdir(), "router-source-identity-"));
  try {
    await writeFile(path.join(checkout, "new.txt"), "first", "utf8");
    const exec = async (_file, args) => {
      const command = args.join(" ");
      if (command === "rev-parse HEAD") return { stdout: Buffer.from("abc123\n"), stderr: Buffer.alloc(0) };
      if (command.startsWith("status ")) return { stdout: Buffer.from("?? new.txt\0"), stderr: Buffer.alloc(0) };
      if (command.startsWith("diff ")) return { stdout: Buffer.from("tracked-diff"), stderr: Buffer.alloc(0) };
      if (command.startsWith("ls-files ")) return { stdout: Buffer.from("new.txt\0"), stderr: Buffer.alloc(0) };
      throw new Error(`unexpected git command ${command}`);
    };
    const identify = createGitSourceIdentityProvider({ exec });
    const first = await identify(checkout);
    await writeFile(path.join(checkout, "new.txt"), "second", "utf8");
    const second = await identify(checkout);
    assert.match(first.sourceRevision, /^abc123\+dirty\.[0-9a-f]{64}$/u);
    assert.equal(first.sourceRevision.endsWith(first.dirtyTreeDigest), true);
    assert.notEqual(second.sourceRevision, first.sourceRevision);
    assert.notEqual(second.dirtyTreeDigest, first.dirtyTreeDigest);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("inline environments are rejected and resolved secret values are scrubbed from artifacts", async () => {
  await withArtifactRoot(async (artifactRoot) => {
    const runner = new DeterministicVerificationRunner({
      artifactRoot,
      clock: tickingClock(),
      sourceIdentity: async () => ({ sourceRevision: "rev" }),
      resolveEnvironment: async (envRef) => ({
        env: { SERVICE_TOKEN: "top-secret-value" },
        secretValues: envRef === "service" ? ["top-secret-value"] : [],
      }),
      processRunner: async () => ({
        exitCode: 0,
        timedOut: false,
        stdout: "token=top-secret-value Authorization: Bearer visible-token",
        stderr: "",
      }),
    });
    await assert.rejects(() => runner.runGate({
      id: "unsafe", command: "unit", cwd: "/repo", env: { TOKEN: "literal" },
    }, { runId: "run", taskId: "task" }), /must use envRef/u);
    const result = await runner.runGate({ id: "safe", command: "unit", cwd: "/repo", envRef: "service" }, {
      runId: "run", taskId: "task",
    });
    const artifact = await readFile(path.join(artifactRoot, result.artifactLocation), "utf8");
    assert.doesNotMatch(artifact, /top-secret-value|visible-token/u);
    assert.match(artifact, /\[REDACTED\]/u);
  });
});

test("post-command identity failures retain command evidence as a failed result", async () => {
  await withArtifactRoot(async (artifactRoot) => {
    let identityCalls = 0;
    const runner = new DeterministicVerificationRunner({
      artifactRoot,
      clock: tickingClock(),
      sourceIdentity: async () => {
        if (identityCalls++ > 0) throw new Error("repository metadata removed");
        return { sourceRevision: "rev" };
      },
      processRunner: async () => ({ exitCode: 0, timedOut: false, stdout: "command completed", stderr: "" }),
    });
    const result = await runner.runGate({ id: "mutating", command: "unit", cwd: "/repo" }, {
      runId: "run", taskId: "task",
    });
    assert.equal(result.exitCode, VERIFICATION_IDENTITY_CHANGED_EXIT_CODE);
    const artifact = JSON.parse(await readFile(path.join(artifactRoot, result.artifactLocation), "utf8"));
    assert.equal(artifact.stdout, "command completed");
    assert.match(artifact.postIdentityError, /metadata removed/u);
  });
});

test("timeout cleanup terminates descendants that ignore SIGTERM", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "router-process-tree-"));
  const pidFile = path.join(directory, "grandchild.pid");
  let grandchildPid;
  try {
    const childProgram = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);")}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const run = createSpawnProcessRunner({ terminateGraceMs: 50 });
    const result = await run({
      command: process.execPath,
      arguments: ["-e", childProgram],
      cwd: directory,
      timeoutMs: 1_000,
    });
    assert.equal(result.timedOut, true);
    grandchildPid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
  } finally {
    if (Number.isSafeInteger(grandchildPid)) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});
