import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";
import { lstat, readFile, readlink } from "node:fs/promises";

import { createEngineeringRecord } from "./contracts.mjs";
import { storeArtifact } from "./artifacts.mjs";

export const VERIFICATION_NOT_RUN_EXIT_CODE = 125;
export const VERIFICATION_IDENTITY_CHANGED_EXIT_CODE = 126;
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 10 * 60 * 1_000;
export const DEFAULT_VERIFICATION_OUTPUT_LIMIT = 16 * 1024 * 1024;

const SECRET_FLAG = /^(?:--?(?:api[-_]?key|auth|authorization|password|secret|token|credential)|bearer)$/iu;
const SECRET_ASSIGNMENT = /^([^=]*(?:api[-_]?key|auth|authorization|password|secret|token|credential)[^=]*)=(.*)$/iu;
const SECRET_HEADER = /^((?:proxy-)?authorization\s*:\s*)(.*)$/iu;
const SECRET_OUTPUT_PATTERNS = [
  /((?:api[-_]?key|password|secret|token|credential)\s*[=:]\s*)[^\s"']+/giu,
  /((?:proxy-)?authorization\s*:\s*(?:bearer\s+)?)[^\s"']+/giu,
  /(bearer\s+)[A-Za-z0-9._~+\/-]+/giu,
];

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function safeInteger(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid date.`);
  return date.toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function appendBounded(chunks, chunk, state, maximumBytes) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (state.bytes >= maximumBytes) {
    state.truncated = true;
    return;
  }
  const remaining = maximumBytes - state.bytes;
  const kept = bytes.subarray(0, remaining);
  if (kept.length) chunks.push(kept);
  state.bytes += kept.length;
  if (kept.length !== bytes.length) state.truncated = true;
}

export function redactVerificationArguments(argumentsList, replacement = "[REDACTED]") {
  if (!Array.isArray(argumentsList) || argumentsList.some((item) => typeof item !== "string")) {
    throw new TypeError("Verification arguments must be an array of strings.");
  }
  const output = [];
  let redactNext = false;
  for (const argument of argumentsList) {
    if (redactNext) {
      output.push(replacement);
      redactNext = false;
      continue;
    }
    const assignment = argument.match(SECRET_ASSIGNMENT);
    if (assignment) {
      output.push(`${assignment[1]}=${replacement}`);
      continue;
    }
    const header = argument.match(SECRET_HEADER);
    if (header) {
      output.push(`${header[1]}${replacement}`);
      continue;
    }
    output.push(argument);
    if (SECRET_FLAG.test(argument)) redactNext = true;
  }
  return output;
}

export function redactVerificationCommand(command, replacement = "[REDACTED]") {
  return redactVerificationArguments([requiredText(command, "Verification command")], replacement)[0];
}

export function redactVerificationOutput(value, secretValues = [], replacement = "[REDACTED]") {
  let output = String(value ?? "");
  for (const pattern of SECRET_OUTPUT_PATTERNS) output = output.replace(pattern, `$1${replacement}`);
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length >= 4) output = output.replaceAll(secret, replacement);
  }
  return output;
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "buffer", maxBuffer: DEFAULT_VERIFICATION_OUTPUT_LIMIT }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

async function untrackedDigest(cwd, paths) {
  const digest = createHash("sha256");
  for (const relative of [...paths].sort()) {
    const target = path.resolve(cwd, relative);
    const root = path.resolve(cwd);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Untracked path escaped checkout: ${relative}`);
    const metadata = await lstat(target);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new Error(`Unsupported untracked artifact type: ${relative}`);
    }
    digest.update(relative).update("\0")
      .update(metadata.isSymbolicLink() ? "symlink" : "file").update("\0")
      .update(String(metadata.mode)).update("\0");
    digest.update(metadata.isSymbolicLink() ? await readlink(target) : await readFile(target)).update("\0");
  }
  return digest.digest();
}

/**
 * Return a provider that binds a gate to HEAD plus every tracked and untracked
 * dirty byte. Callers may inject an equivalent repository-aware provider.
 */
export function createGitSourceIdentityProvider({ exec = execFilePromise } = {}) {
  return async function gitSourceIdentity(cwd) {
    requiredText(cwd, "Verification cwd");
    // Serialize repository observations. The runner also checks identity again
    // after the gate, so an interleaved mutation fails the gate.
    const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd });
    const { stdout: status } = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
    const { stdout: diff } = await exec("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], { cwd });
    const { stdout: untracked } = await exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
    const headRevision = Buffer.from(head).toString("utf8").trim();
    requiredText(headRevision, "Git source revision");
    const untrackedPaths = Buffer.from(untracked).toString("utf8").split("\0").filter(Boolean);
    const dirty = Buffer.from(status).length > 0;
    const dirtyTreeDigest = dirty
      ? createHash("sha256")
        .update(headRevision)
        .update("\0")
        .update(Buffer.from(status))
        .update("\0")
        .update(Buffer.from(diff))
        .update("\0")
        .update(await untrackedDigest(cwd, untrackedPaths))
        .digest("hex")
      : undefined;
    // Acceptance compares sourceRevision directly. For a dirty checkout it
    // therefore names the complete dirty identity rather than merely HEAD.
    const sourceRevision = dirty ? `${headRevision}+dirty.${dirtyTreeDigest}` : headRevision;
    return Object.freeze({ sourceRevision, ...(dirtyTreeDigest ? { dirtyTreeDigest } : {}) });
  };
}

export function sourceIdentityMatches(actual, expected) {
  if (!actual || !expected) return false;
  return actual.sourceRevision === expected.sourceRevision
    && (actual.dirtyTreeDigest ?? null) === (expected.dirtyTreeDigest ?? null);
}

export function createSpawnProcessRunner({
  spawnImpl = spawn,
  outputLimit = DEFAULT_VERIFICATION_OUTPUT_LIMIT,
  terminateGraceMs = 1_000,
} = {}) {
  safeInteger(outputLimit, "Verification output limit", { minimum: 1 });
  safeInteger(terminateGraceMs, "Verification terminate grace", { minimum: 1 });
  return async function runProcess({ command, arguments: args, cwd, timeoutMs, env, signal: abortSignal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const stdout = [];
      const stderr = [];
      const stdoutState = { bytes: 0, truncated: false };
      const stderrState = { bytes: 0, truncated: false };
      let timer;
      let forceTimer;
      let terminationStarted = false;
      let forceCleanupFinished = false;
      let closeOutcome;
      let child;
      try {
        child = spawnImpl(command, args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          ...(process.platform === "win32" ? {} : { detached: true }),
        });
      } catch (error) {
        reject(error);
        return;
      }
      child.stdout?.on("data", (chunk) => appendBounded(stdout, chunk, stdoutState, outputLimit));
      child.stderr?.on("data", (chunk) => appendBounded(stderr, chunk, stderrState, outputLimit));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        abortSignal?.removeEventListener?.("abort", abort);
        reject(error);
      });
      const finishAfterCleanup = () => {
        if (settled || !closeOutcome || (terminationStarted && !forceCleanupFinished)) return;
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener?.("abort", abort);
        resolve({
          exitCode: closeOutcome.exitCode === null ? undefined : closeOutcome.exitCode,
          signal: closeOutcome.signal || undefined,
          timedOut,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdoutTruncated: stdoutState.truncated,
          stderrTruncated: stderrState.truncated,
        });
      };
      child.once("close", (exitCode, signal) => {
        closeOutcome = { exitCode, signal };
        finishAfterCleanup();
      });
      const killTree = (signal, done = () => {}) => {
        if (process.platform === "win32" && child.pid) {
          execFile("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], () => done());
          return;
        }
        try {
          if (child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          child.kill(signal);
        }
        if (signal !== "SIGKILL" || !child.pid) {
          done();
          return;
        }
        const deadline = Date.now() + 1_000;
        const waitForProcessGroupExit = () => {
          try {
            process.kill(-child.pid, 0);
          } catch (error) {
            if (error?.code === "ESRCH") {
              done();
              return;
            }
          }
          if (Date.now() >= deadline) {
            done();
            return;
          }
          setTimeout(waitForProcessGroupExit, 10);
        };
        waitForProcessGroupExit();
      };
      const terminate = (timeout) => {
        if (settled || terminationStarted) return;
        terminationStarted = true;
        if (timeout) timedOut = true;
        killTree("SIGTERM");
        forceTimer = setTimeout(() => {
          killTree("SIGKILL", () => {
            forceCleanupFinished = true;
            finishAfterCleanup();
          });
        }, terminateGraceMs);
        forceTimer.unref?.();
      };
      const abort = () => terminate(false);
      if (abortSignal?.aborted) abort();
      else abortSignal?.addEventListener?.("abort", abort, { once: true });
      timer = setTimeout(() => {
        terminate(true);
      }, timeoutMs);
      timer.unref?.();
    });
  };
}

function normalizeGate(gate, defaults = {}) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) throw new TypeError("Verification gate must be an object.");
  const verificationId = requiredText(gate.verificationId ?? gate.id, "Verification gate id");
  const command = requiredText(gate.command, `Verification gate ${verificationId} command`);
  const args = gate.arguments ?? gate.args ?? [];
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw new TypeError(`Verification gate ${verificationId} arguments must be strings.`);
  }
  const timeoutMs = gate.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  safeInteger(timeoutMs, `Verification gate ${verificationId} timeout`, { minimum: 1 });
  if (gate.env !== undefined) {
    throw new Error(`Verification gate ${verificationId} must use envRef; inline environments cannot be persisted.`);
  }
  if (gate.envRef !== undefined && (typeof gate.envRef !== "string" || !gate.envRef.trim())) {
    throw new TypeError(`Verification gate ${verificationId} envRef must be a non-empty string.`);
  }
  return {
    verificationId,
    command,
    arguments: [...args],
    cwd: requiredText(gate.cwd ?? defaults.cwd, `Verification gate ${verificationId} cwd`),
    timeoutMs,
    testCount: gate.testCount ?? 0,
    enabled: gate.enabled !== false && gate.skip !== true,
    notRunReason: gate.notRunReason ?? gate.skipReason,
    ...(gate.envRef ? { envRef: gate.envRef } : {}),
  };
}

function resultPassed(result) {
  return result.timedOut !== true && result.signal === undefined && result.exitCode === 0;
}

export function verificationResultPassed(result) {
  return resultPassed(result);
}

function artifactReferenceText(reference) {
  return `${reference.path}#sha256=${reference.sha256}&bytes=${reference.size}`;
}

export class DeterministicVerificationRunner {
  constructor({
    processRunner = createSpawnProcessRunner(),
    sourceIdentity = createGitSourceIdentityProvider(),
    artifactRoot,
    artifactWriter,
    clock = () => new Date(),
    host = hostname(),
    idFactory = () => `verification_${randomUUID()}`,
    redactArguments = redactVerificationArguments,
    redactOutput = redactVerificationOutput,
    resolveEnvironment = async () => ({ env: undefined, secretValues: [] }),
    operationInspector,
  } = {}) {
    if (typeof processRunner !== "function") throw new TypeError("processRunner must be a function.");
    if (typeof sourceIdentity !== "function") throw new TypeError("sourceIdentity must be a function.");
    if (!artifactWriter && !artifactRoot) throw new TypeError("Verification requires artifactRoot or artifactWriter.");
    this.processRunner = processRunner;
    this.sourceIdentity = sourceIdentity;
    this.artifactRoot = artifactRoot;
    this.artifactWriter = artifactWriter || ((relativePath, contents) => storeArtifact(artifactRoot, relativePath, contents));
    this.clock = clock;
    this.host = requiredText(host, "Verification host");
    this.idFactory = idFactory;
    this.redactArguments = redactArguments;
    this.redactOutput = redactOutput;
    this.resolveEnvironment = resolveEnvironment;
    this.operationInspector = operationInspector;
  }

  async inspect(request) {
    if (typeof this.operationInspector !== "function") {
      return { state: "missing", reason: "verification operation is not recoverable by this executor" };
    }
    return this.operationInspector(request);
  }

  async #writeArtifact({ runId, taskId, attemptId, verificationId, payload }) {
    const components = [runId, taskId, attemptId, `${verificationId}.json`].map((part) =>
      requiredText(part, "Verification artifact path component").replaceAll(/[^A-Za-z0-9._-]/gu, "_"));
    const relativePath = components.join("/");
    return this.artifactWriter(relativePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  async #syntheticFailure(gate, context, reason, exitCode = VERIFICATION_NOT_RUN_EXIT_CODE, observedIdentity) {
    const timestamp = iso(this.clock(), "Verification timestamp");
    const identity = observedIdentity ?? await this.sourceIdentity(gate.cwd);
    const payload = {
      schemaVersion: 1,
      outcome: "not_run",
      reason,
      command: redactVerificationCommand(gate.command),
      arguments: this.redactArguments(gate.arguments),
      cwd: gate.cwd,
      identity,
      startedAt: timestamp,
      finishedAt: timestamp,
      exitCode,
    };
    const artifact = await this.#writeArtifact({ ...context, verificationId: gate.verificationId, payload });
    return createEngineeringRecord("VerificationResult", {
      taskId: context.taskId,
      verificationId: gate.verificationId,
      runner: context.runner,
      command: payload.command,
      arguments: payload.arguments,
      cwd: gate.cwd,
      host: this.host,
      sourceRevision: identity.sourceRevision,
      ...(identity.dirtyTreeDigest ? { dirtyTreeDigest: identity.dirtyTreeDigest } : {}),
      exitCode,
      timedOut: false,
      testCount: 0,
      artifactDigest: artifact.sha256,
      artifactLocation: artifact.path,
      artifactRefs: [artifactReferenceText(artifact)],
      startedAt: timestamp,
      finishedAt: timestamp,
    });
  }

  async runGate(gateInput, context = {}) {
    const gate = normalizeGate(gateInput, context);
    const normalizedContext = {
      runId: requiredText(context.runId, "Verification runId"),
      taskId: requiredText(context.taskId, "Verification taskId"),
      attemptId: requiredText(context.attemptId ?? "composition", "Verification attemptId"),
      runner: requiredText(context.runner ?? "deterministic-runner", "Verification runner"),
    };
    if (!gate.enabled) {
      return this.#syntheticFailure(gate, normalizedContext, gate.notRunReason || "gate disabled or skipped");
    }

    const before = await this.sourceIdentity(gate.cwd);
    const expected = context.expectedIdentity;
    if (expected && !sourceIdentityMatches(before, expected)) {
      return this.#syntheticFailure(
        gate,
        normalizedContext,
        "source identity did not match the configured revision",
        VERIFICATION_IDENTITY_CHANGED_EXIT_CODE,
        before,
      );
    }
    const startedAt = iso(this.clock(), "Verification start timestamp");
    const environment = await this.resolveEnvironment(gate.envRef, {
      runId: normalizedContext.runId,
      taskId: normalizedContext.taskId,
      verificationId: gate.verificationId,
    });
    if (!environment || typeof environment !== "object" || !Array.isArray(environment.secretValues || [])) {
      throw new TypeError("Verification environment resolver must return { env, secretValues }.");
    }
    let execution;
    try {
      execution = await this.processRunner({
        operationId: context.operationId ?? this.idFactory(),
        command: gate.command,
        arguments: [...gate.arguments],
        cwd: gate.cwd,
        timeoutMs: gate.timeoutMs,
        env: environment.env,
        signal: context.signal,
      });
    } catch (error) {
      execution = { exitCode: 127, timedOut: false, stdout: "", stderr: String(error?.stack || error) };
    }
    const finishedAt = iso(this.clock(), "Verification finish timestamp");
    let after;
    let postIdentityError;
    try {
      after = await this.sourceIdentity(gate.cwd);
    } catch (error) {
      postIdentityError = String(error?.message || error);
    }
    const identityChanged = postIdentityError !== undefined || !sourceIdentityMatches(before, after);
    let exitCode = execution.exitCode;
    let signal = execution.signal;
    const timedOut = execution.timedOut === true;
    if (identityChanged) {
      exitCode = VERIFICATION_IDENTITY_CHANGED_EXIT_CODE;
      signal = undefined;
    }
    if (exitCode === undefined && signal === undefined && !timedOut) exitCode = 127;
    const redactedArguments = this.redactArguments(gate.arguments);
    const payload = {
      schemaVersion: 1,
      outcome: timedOut ? "timeout" : identityChanged ? "source_changed" : exitCode === 0 && !signal ? "passed" : "failed",
      command: redactVerificationCommand(gate.command),
      arguments: redactedArguments,
      cwd: gate.cwd,
      host: this.host,
      sourceIdentityBefore: before,
      sourceIdentityAfter: after,
      ...(postIdentityError ? { postIdentityError: this.redactOutput(postIdentityError, environment.secretValues) } : {}),
      timeoutMs: gate.timeoutMs,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      timedOut,
      testCount: execution.testCount ?? gate.testCount,
      stdout: this.redactOutput(execution.stdout ?? "", environment.secretValues),
      stderr: this.redactOutput(execution.stderr ?? "", environment.secretValues),
      stdoutTruncated: execution.stdoutTruncated === true,
      stderrTruncated: execution.stderrTruncated === true,
      startedAt,
      finishedAt,
    };
    const artifact = await this.#writeArtifact({ ...normalizedContext, verificationId: gate.verificationId, payload });
    return createEngineeringRecord("VerificationResult", {
      taskId: normalizedContext.taskId,
      verificationId: gate.verificationId,
      runner: normalizedContext.runner,
      command: payload.command,
      arguments: redactedArguments,
      cwd: gate.cwd,
      host: this.host,
      sourceRevision: before.sourceRevision,
      ...(before.dirtyTreeDigest ? { dirtyTreeDigest: before.dirtyTreeDigest } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(signal ? { signal } : {}),
      timedOut,
      testCount: safeInteger(execution.testCount ?? gate.testCount, "Verification test count"),
      artifactDigest: artifact.sha256,
      artifactLocation: artifact.path,
      artifactRefs: [artifactReferenceText(artifact)],
      startedAt,
      finishedAt,
    });
  }

  async runPlan(gates, context = {}) {
    if (!Array.isArray(gates) || gates.length === 0) throw new TypeError("Verification plan must contain at least one gate.");
    const normalized = gates.map((gate) => normalizeGate(gate, context));
    if (new Set(normalized.map((gate) => gate.verificationId)).size !== normalized.length) {
      throw new Error("Verification gate ids must be unique.");
    }
    const results = [];
    let priorFailure;
    for (const gate of normalized) {
      const result = priorFailure
        ? await this.#syntheticFailure(gate, {
          runId: requiredText(context.runId, "Verification runId"),
          taskId: requiredText(context.taskId, "Verification taskId"),
          attemptId: requiredText(context.attemptId ?? "composition", "Verification attemptId"),
          runner: requiredText(context.runner ?? "deterministic-runner", "Verification runner"),
        }, `not run because ${priorFailure} failed`)
        : await this.runGate(gate, context);
      results.push(result);
      if (!resultPassed(result)) priorFailure = gate.verificationId;
    }
    return Object.freeze(results);
  }
}
