import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { createEvidencePacket } from "./evidence.mjs";
import { evaluateEngineeringAcceptance } from "./evidence.mjs";
import { redactVerificationArguments, redactVerificationCommand } from "./verification.mjs";

const COMPOSITION_STATES = new Set(["verifying", "reviewing", "integrating"]);
const TERMINAL_STATES = new Set(["accepted", "cancelled", "failed", "blocked"]);
const MAX_PERSISTED_ERROR_BYTES = 2 * 1024;

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function safeError(value) {
  let message = String(value?.message || value || "unknown error")
    .replace(/((?:api[-_]?key|password|secret|token|credential)\s*[=:]\s*)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/((?:proxy-)?authorization\s*:\s*(?:bearer\s+)?)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/([?&](?:api[-_]?key|token|secret|credential)=)[^&#\s]+/giu, "$1[REDACTED]");
  while (Buffer.byteLength(message) > MAX_PERSISTED_ERROR_BYTES) message = message.slice(0, -1);
  return message;
}

function sameResultIdentity(left, right) {
  return Boolean(left && right)
    && left.attemptId === right.attemptId
    && left.operationId === right.operationId;
}

function notificationKey(task, result) {
  return `result:${task.runId}:${task.taskId}:${result.attemptId}:${result.operationId}`;
}

function operationKey(task, phase) {
  return `${task.runId}:${task.taskId}:${task.composition.sourceRevision}:${phase}:${task.composition.fence}`;
}

function normalizeReviewResults(value) {
  if (value === undefined || value === null) return [];
  const results = Array.isArray(value) ? value : [value];
  if (results.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new TypeError("Review results must be objects.");
  }
  return copy(results);
}

function persistedVerificationGates(gates) {
  if (!Array.isArray(gates) || gates.length === 0) throw new Error("At least one deterministic verification gate is required.");
  return gates.map((gate, index) => {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) throw new TypeError(`Verification gate ${index} must be an object.`);
    const allowed = new Set([
      "id", "verificationId", "command", "args", "arguments", "cwd", "timeoutMs", "testCount",
      "enabled", "skip", "notRunReason", "skipReason", "envRef",
    ]);
    const unknown = Object.keys(gate).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Verification gate ${index} contains unsupported field ${unknown}.`);
    if (gate.env !== undefined) throw new Error(`Verification gate ${index} must use envRef; inline environments cannot be persisted.`);
    const args = gate.arguments ?? gate.args ?? [];
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
      throw new TypeError(`Verification gate ${index} arguments must be strings.`);
    }
    if (redactVerificationCommand(gate.command) !== gate.command || !isDeepStrictEqual(redactVerificationArguments(args), args)) {
      throw new Error(`Verification gate ${index} contains a secret-bearing command or argument; use envRef.`);
    }
    if (gate.envRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(gate.envRef)) {
      throw new TypeError(`Verification gate ${index} envRef is invalid.`);
    }
    return copy(gate);
  });
}

function hasPassingVerification(results) {
  return results.length > 0 && results.every((result) =>
    result.timedOut !== true && result.signal === undefined && result.exitCode === 0);
}

function matchingWorkerRevision(task, sourceRevision) {
  return task.workerResult?.resultRevision === sourceRevision
    || task.workerResult?.sourceRevision === sourceRevision
    || task.workerResult?.revision === sourceRevision;
}

/**
 * Coordinates the scheduler's worker phase with revision-bound verification,
 * review, lead judgment, and final evidence composition. The scheduler remains
 * the owner of worker leases/fences. This controller uses task-record CAS for a
 * separate composition fence after the worker result releases its writer lease.
 */
export class EngineeringRunController {
  constructor({
    scheduler,
    state = scheduler?.state,
    verifier,
    integrator,
    reviewer,
    astraLead,
    notifier = async () => undefined,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}_${randomUUID()}`,
    controllerId,
    maximumCasRetries = 8,
  } = {}) {
    if (!scheduler || !state) throw new TypeError("EngineeringRunController requires scheduler and state adapters.");
    for (const method of ["getTask", "listTasks", "putTask"]) {
      if (typeof state[method] !== "function") throw new TypeError(`Run-controller state is missing ${method}().`);
    }
    if (!verifier || typeof verifier.runPlan !== "function") throw new TypeError("Run controller requires verifier.runPlan().");
    if (integrator !== undefined && typeof integrator !== "function" && typeof integrator?.integrate !== "function") {
      throw new TypeError("integrator must be a function or expose integrate().");
    }
    if (reviewer !== undefined && typeof reviewer !== "function" && typeof reviewer?.review !== "function") {
      throw new TypeError("reviewer must be a function or expose review().");
    }
    if (astraLead !== undefined && typeof astraLead !== "function" && typeof astraLead?.decide !== "function") {
      throw new TypeError("astraLead must be a function or expose decide().");
    }
    if (typeof notifier !== "function") throw new TypeError("notifier must be a function.");
    if (!Number.isSafeInteger(maximumCasRetries) || maximumCasRetries < 1) throw new TypeError("maximumCasRetries must be positive.");
    this.scheduler = scheduler;
    this.state = state;
    this.verifier = verifier;
    this.integrator = integrator;
    this.reviewer = reviewer;
    this.astraLead = astraLead;
    this.notifier = notifier;
    this.clock = clock;
    this.idFactory = idFactory;
    this.controllerId = requiredText(controllerId, "controllerId (must remain stable across restarts)");
    this.maximumCasRetries = maximumCasRetries;
  }

  async #update(taskId, transform) {
    for (let attempt = 0; attempt < this.maximumCasRetries; attempt += 1) {
      const current = await this.state.getTask(taskId);
      if (!current) throw new Error(`Unknown engineering task ${taskId}.`);
      const patch = await transform(copy(current));
      if (patch === undefined) return current;
      try {
        return await this.state.putTask(
          { ...current, ...copy(patch), updatedAt: this.clock() },
          { expectedRevision: current.revision },
        );
      } catch (error) {
        if (!/revision conflict/iu.test(String(error?.message || error)) || attempt + 1 === this.maximumCasRetries) throw error;
      }
    }
    throw new Error(`Task ${taskId} CAS retry limit exhausted.`);
  }

  async dispatchReady(runId) {
    return this.scheduler.dispatchReady(requiredText(runId, "runId"));
  }

  async #queueNotification(taskId) {
    return this.#update(taskId, (task) => {
      if (!task.workerResult) return undefined;
      const key = notificationKey(task, task.workerResult);
      if (task.resultNotification?.idempotencyKey === key) return undefined;
      return {
        resultNotification: {
          idempotencyKey: key,
          status: "pending",
          queuedAt: this.clock(),
          attempts: 0,
        },
      };
    });
  }

  async #deliverNotification(taskId) {
    let task = await this.state.getTask(taskId);
    const notification = task?.resultNotification;
    if (!notification || notification.status === "delivered") return task;
    if (!task.workerResult) throw new Error(`Task ${taskId} notification has no persisted worker result.`);
    try {
      await this.notifier({
        idempotencyKey: notification.idempotencyKey,
        task: copy(task),
        result: copy(task.workerResult),
      });
    } catch (error) {
      return this.#update(taskId, (current) => {
        if (current.resultNotification?.idempotencyKey !== notification.idempotencyKey) return undefined;
        return {
          resultNotification: {
            ...current.resultNotification,
            attempts: (current.resultNotification.attempts || 0) + 1,
            lastAttemptAt: this.clock(),
            lastError: safeError(error),
          },
        };
      });
    }
    task = await this.#update(taskId, (current) => {
      if (current.resultNotification?.idempotencyKey !== notification.idempotencyKey) return undefined;
      if (current.resultNotification.status === "delivered") return undefined;
      return {
        resultNotification: {
          ...current.resultNotification,
          status: "delivered",
          attempts: (current.resultNotification.attempts || 0) + 1,
          lastAttemptAt: this.clock(),
          deliveredAt: this.clock(),
          lastError: undefined,
        },
      };
    });
    return task;
  }

  async acknowledgeResult(taskId, { acknowledgementId } = {}) {
    const current = await this.state.getTask(taskId);
    if (!current) throw new Error(`Unknown engineering task ${taskId}.`);
    if (!current.workerResult) throw new Error(`Task ${taskId} has no recorded result to acknowledge.`);
    const expected = notificationKey(current, current.workerResult);
    const id = acknowledgementId ?? expected;
    requiredText(id, "acknowledgementId");
    if (id !== expected) throw new Error(`Task ${taskId} acknowledgement id does not match its persisted result.`);
    if (typeof this.state.acknowledgeIncorporation === "function") {
      const acknowledgement = await this.state.acknowledgeIncorporation({
        taskId,
        expectedRevision: current.revision,
        attemptId: current.workerResult.attemptId,
        operationId: current.workerResult.operationId,
        incorporationId: id,
        updatedAt: this.clock(),
      });
      if (!acknowledgement.ok) throw new Error(`Task ${taskId} result changed before acknowledgement.`);
      return acknowledgement.task;
    }
    return this.#update(taskId, (task) => {
      if (!task.workerResult) throw new Error(`Task ${taskId} has no recorded result to acknowledge.`);
      if (task.resultAcknowledgement) {
        if (task.resultAcknowledgement.id !== id) {
          throw new Error(`Task ${taskId} result was already acknowledged with a different id.`);
        }
        return undefined;
      }
      return { resultAcknowledgement: { id, acknowledgedAt: this.clock() } };
    });
  }

  async recordWorkerResult(taskId, result, { notify = true, acknowledge = true } = {}) {
    requiredText(taskId, "taskId");
    if (!result || typeof result !== "object") throw new TypeError("Worker result must be an object.");
    requiredText(result.attemptId, "Worker result attemptId");
    requiredText(result.operationId, "Worker result operationId");
    let task = await this.state.getTask(taskId);
    if (!task) throw new Error(`Unknown engineering task ${taskId}.`);
    let duplicate = false;
    if (sameResultIdentity(task.workerResult, result)) {
      if (!isDeepStrictEqual(task.workerResult, result)) {
        throw new Error(`Task ${taskId} received conflicting payloads for one result operation.`);
      }
      duplicate = true;
    } else {
      const recorded = await this.scheduler.recordResult(taskId, result);
      if (!recorded.integrable) {
        return { ...recorded, duplicate: sameResultIdentity(recorded.task?.workerResult, result) };
      }
      task = recorded.task;
    }
    // The scheduler has durably stored workerResult before any notification.
    task = await this.#queueNotification(taskId);
    if (acknowledge) task = await this.acknowledgeResult(taskId);
    if (notify) task = await this.#deliverNotification(taskId);
    return { integrable: true, duplicate, task };
  }

  async #claimComposition(taskId, options) {
    const sourceRevision = requiredText(
      options.sourceRevision,
      "Composition sourceRevision",
    );
    return this.#update(taskId, (task) => {
      if (task.state === "accepted") return undefined;
      if (task.composition) {
        if (task.composition.sourceRevision !== sourceRevision) {
          throw new Error(`Task ${taskId} already has composition evidence for another source revision.`);
        }
        if (task.composition.owner !== this.controllerId) {
          throw new Error(`Task ${taskId} composition is owned by another controller.`);
        }
        return undefined;
      }
      if (task.state !== "result_recorded") {
        throw new Error(`Task ${taskId} cannot begin composition from ${task.state}.`);
      }
      if (!matchingWorkerRevision(task, sourceRevision)) {
        throw new Error(`Task ${taskId} worker result is not bound to ${sourceRevision}.`);
      }
      const verificationGates = persistedVerificationGates(options.verificationGates || []);
      const requiredVerificationIds = options.requiredVerificationIds
        ? [...options.requiredVerificationIds]
        : verificationGates.map((gate) => gate.verificationId ?? gate.id);
      if (options.integrationRequired === true && !this.integrator) {
        throw new Error("Multi-worker composition requires an integrator before verification.");
      }
      const integrationRequired = options.integrationRequired === true;
      return {
        state: integrationRequired ? "integrating" : "verifying",
        composition: {
          owner: this.controllerId,
          fence: (task.compositionFence || 0) + 1,
          sourceRevision,
          dirtyTreeDigest: options.dirtyTreeDigest,
          stage: integrationRequired ? "integration_pending" : "verification_pending",
          integrationRequired,
          verificationGates,
          requiredVerificationIds,
          requireReview: options.requireReview !== false,
          requireLeadAcceptance: options.requireLeadAcceptance !== false,
          summary: options.summary || task.workerResult.summary || "",
          rawArtifactReferences: copy(options.rawArtifactReferences || task.workerResult.evidenceRefs || []),
          criticalExcerpts: copy(options.criticalExcerpts || []),
          acceptedResultReferences: copy(options.acceptedResultReferences || task.workerResult.evidenceRefs || []),
          reviewDisagreements: copy(options.reviewDisagreements || []),
          residualRisks: copy(options.residualRisks || task.workerResult.risks || []),
          routingSummary: copy(options.routingSummary),
          usageSummary: copy(options.usageSummary),
          claimedAt: this.clock(),
        },
        compositionFence: (task.compositionFence || 0) + 1,
      };
    });
  }

  async #markStageRunning(task, phase) {
    const operationId = operationKey(task, phase);
    let claimed = false;
    const updated = await this.#update(task.taskId, (current) => {
      claimed = false;
      if (current.composition?.owner !== this.controllerId || current.composition?.fence !== task.composition.fence) {
        throw new Error(`Task ${task.taskId} lost its composition fence.`);
      }
      if (current.composition.stage !== `${phase}_pending`) return undefined;
      claimed = true;
      return {
        composition: {
          ...current.composition,
          stage: `${phase}_running`,
          operation: { phase, operationId, startedAt: this.clock() },
        },
      };
    });
    return { task: updated, claimed };
  }

  #operationMatches(current, running, phase) {
    return current.composition?.owner === running.composition.owner
      && current.composition?.fence === running.composition.fence
      && current.composition?.stage === `${phase}_running`
      && current.composition?.operation?.operationId === running.composition.operation?.operationId;
  }

  async #completeStage(running, phase, transform) {
    return this.#update(running.taskId, (current) => {
      if (!this.#operationMatches(current, running, phase)) return undefined;
      return transform(current);
    });
  }

  async #failComposition(running, phase, error) {
    return this.#completeStage(running, phase, (current) => ({
      state: "needs_remediation",
      composition: {
        ...current.composition,
        stage: `${phase}_failed`,
        failure: { phase, message: safeError(error), at: this.clock() },
      },
    }));
  }

  async #executeVerification(task) {
    const claim = await this.#markStageRunning(task, "verification");
    if (!claim.claimed) return claim.task;
    const running = claim.task;
    try {
      const results = await this.verifier.runPlan(running.composition.verificationGates, {
        runId: running.runId,
        taskId: running.taskId,
        attemptId: running.workerResult?.attemptId ?? "composition",
        operationId: running.composition.operation.operationId,
        expectedIdentity: {
          sourceRevision: running.composition.sourceRevision,
          ...(running.composition.dirtyTreeDigest ? { dirtyTreeDigest: running.composition.dirtyTreeDigest } : {}),
        },
      });
      return this.#completeStage(running, "verification", (current) => ({
          state: "reviewing",
          composition: {
            ...current.composition,
            stage: "review_pending",
            verificationResults: copy(results),
            verificationFinishedAt: this.clock(),
          },
        }));
    } catch (error) {
      return this.#failComposition(running, "verification", error);
    }
  }

  async #executeIntegration(task) {
    const claim = await this.#markStageRunning(task, "integration");
    if (!claim.claimed) return claim.task;
    const running = claim.task;
    try {
      const invoke = typeof this.integrator === "function" ? this.integrator : this.integrator.integrate.bind(this.integrator);
      const result = await invoke({
        operationId: running.composition.operation.operationId,
        task: copy(running),
        sourceRevision: running.composition.sourceRevision,
        workerResult: copy(running.workerResult),
      });
      const sourceRevision = requiredText(result?.sourceRevision, "Integrated source revision");
      if (!result.workerResult || typeof result.workerResult !== "object") {
        throw new Error("Integrator must return a revision-bound workerResult for the integrated tree.");
      }
      if (!matchingWorkerRevision({ workerResult: result.workerResult }, sourceRevision)) {
        throw new Error("Integrator workerResult is not bound to the integrated source revision.");
      }
      return this.#completeStage(running, "integration", (current) => ({
        state: "verifying",
        composition: {
          ...current.composition,
          stage: "verification_pending",
          preIntegrationSourceRevision: current.composition.sourceRevision,
          sourceRevision,
          dirtyTreeDigest: result.dirtyTreeDigest,
          integrationResult: copy(result.workerResult),
          integrationFinishedAt: this.clock(),
        },
      }));
    } catch (error) {
      return this.#failComposition(running, "integration", error);
    }
  }

  async #executeReview(task) {
    if (task.composition.requireReview !== true) {
      return this.#update(task.taskId, (current) => ({
        state: "integrating",
        composition: { ...current.composition, stage: "lead_pending", reviewResults: [] },
      }));
    }
    const claim = await this.#markStageRunning(task, "review");
    if (!claim.claimed) return claim.task;
    const running = claim.task;
    if (!this.reviewer) return this.#failComposition(running, "review", new Error("Required reviewer is unavailable."));
    try {
      const invoke = typeof this.reviewer === "function" ? this.reviewer : this.reviewer.review.bind(this.reviewer);
      const results = normalizeReviewResults(await invoke({
        operationId: running.composition.operation.operationId,
        task: copy(running),
        sourceRevision: running.composition.sourceRevision,
        verificationResults: copy(running.composition.verificationResults),
      }));
      return this.#completeStage(running, "review", (current) => ({
        state: "integrating",
        composition: {
          ...current.composition,
          stage: "lead_pending",
          reviewResults: results,
          reviewFinishedAt: this.clock(),
        },
      }));
    } catch (error) {
      return this.#failComposition(running, "review", error);
    }
  }

  #acceptance(task, leadDecision, requireLeadAcceptance = task.composition.requireLeadAcceptance) {
    return evaluateEngineeringAcceptance({
      revision: task.composition.sourceRevision,
      workerResults: [task.composition.integrationResult || task.workerResult],
      verificationResults: task.composition.verificationResults || [],
      reviewResults: task.composition.reviewResults || [],
      requiredVerificationIds: task.composition.requiredVerificationIds,
      requireReview: task.composition.requireReview,
      requireLeadAcceptance,
      leadDecision,
    });
  }

  #packet(task, acceptance, leadDecision) {
    return createEvidencePacket({
      runId: task.runId,
      taskId: task.taskId,
      revision: task.composition.sourceRevision,
      summary: task.composition.summary,
      acceptance,
      unresolvedFailures: acceptance.blockers,
      rawArtifactReferences: task.composition.rawArtifactReferences,
      criticalExcerpts: task.composition.criticalExcerpts,
      acceptedResultReferences: task.composition.acceptedResultReferences,
      reviewDisagreements: task.composition.reviewDisagreements,
      residualRisks: task.composition.residualRisks,
      routingSummary: task.composition.routingSummary,
      usageSummary: task.composition.usageSummary,
      leadDecision,
      generatedAt: this.clock(),
    });
  }

  async #executeLead(task) {
    if (task.composition.requireLeadAcceptance !== true) {
      return this.#update(task.taskId, (current) => ({
        composition: {
          ...current.composition,
          stage: "final_pending",
          leadDecision: { decision: "accept", revision: current.composition.sourceRevision, source: "policy-not-required" },
        },
      }));
    }
    const claim = await this.#markStageRunning(task, "lead");
    if (!claim.claimed) return claim.task;
    const running = claim.task;
    if (!this.astraLead) return this.#failComposition(running, "lead", new Error("Required Astra lead is unavailable."));
    try {
      const provisionalAcceptance = this.#acceptance(running, undefined, false);
      const provisionalPacket = this.#packet(running, provisionalAcceptance, undefined);
      const invoke = typeof this.astraLead === "function" ? this.astraLead : this.astraLead.decide.bind(this.astraLead);
      const leadDecision = await invoke({
        operationId: running.composition.operation.operationId,
        task: copy(running),
        evidencePacket: provisionalPacket,
        sourceRevision: running.composition.sourceRevision,
      });
      if (!leadDecision || !["accept", "reject"].includes(leadDecision.decision)) {
        throw new Error("Astra lead returned no valid accept/reject decision.");
      }
      if (leadDecision.revision !== running.composition.sourceRevision) {
        throw new Error("Astra lead decision is stale or missing the exact source revision.");
      }
      return this.#completeStage(running, "lead", (current) => ({
        composition: {
          ...current.composition,
          stage: "final_pending",
          leadDecision: copy(leadDecision),
          leadFinishedAt: this.clock(),
        },
      }));
    } catch (error) {
      return this.#failComposition(running, "lead", error);
    }
  }

  async #finalize(task) {
    return this.#update(task.taskId, (current) => {
      if (
        current.composition?.owner !== task.composition.owner
        || current.composition?.fence !== task.composition.fence
        || current.composition?.stage !== "final_pending"
      ) return undefined;
      const acceptance = this.#acceptance(current, current.composition.leadDecision);
      const packet = this.#packet(current, acceptance, current.composition.leadDecision);
      return {
        state: acceptance.accepted ? "accepted" : "needs_remediation",
        acceptance,
        evidencePacket: packet,
        composition: {
          ...current.composition,
          stage: acceptance.accepted ? "accepted" : "rejected",
          completedAt: this.clock(),
        },
      };
    });
  }

  async #inspectRunningStage(task) {
    const phase = task.composition.stage.replace(/_running$/u, "");
    const adapter = phase === "integration"
      ? this.integrator
      : phase === "verification" ? this.verifier : phase === "review" ? this.reviewer : this.astraLead;
    const inspect = adapter && typeof adapter !== "function" ? adapter.inspect : undefined;
    if (typeof inspect !== "function") {
      return {
        task: await this.#failComposition(
          task,
          phase,
          new Error(`Recorded ${phase} operation cannot be reconciled by its adapter.`),
        ),
      };
    }
    const observation = await inspect({
      operationId: task.composition.operation.operationId,
      task: copy(task),
      phase,
    });
    if (!observation || ["unknown", "running", "timeout"].includes(observation.state)) {
      return { task, waiting: true, phase };
    }
    if (observation.state !== "result") {
      return { task: await this.#failComposition(task, phase, new Error(observation.reason || `Recorded ${phase} operation did not complete.`)) };
    }
    if (phase === "verification") {
      return { task: await this.#completeStage(task, phase, (current) => ({
        state: "reviewing",
        composition: { ...current.composition, stage: "review_pending", verificationResults: copy(observation.result), verificationFinishedAt: this.clock() },
      })) };
    }
    if (phase === "integration") {
      const result = observation.result;
      const sourceRevision = requiredText(result?.sourceRevision, "Recovered integrated source revision");
      if (!result.workerResult || !matchingWorkerRevision({ workerResult: result.workerResult }, sourceRevision)) {
        return { task: await this.#failComposition(task, phase, new Error("Recovered integration result is not revision-bound.")) };
      }
      return { task: await this.#completeStage(task, phase, (current) => ({
        state: "verifying",
        composition: {
          ...current.composition,
          stage: "verification_pending",
          preIntegrationSourceRevision: current.composition.sourceRevision,
          sourceRevision,
          dirtyTreeDigest: result.dirtyTreeDigest,
          integrationResult: copy(result.workerResult),
          integrationFinishedAt: this.clock(),
        },
      })) };
    }
    if (phase === "review") {
      return { task: await this.#completeStage(task, phase, (current) => ({
        state: "integrating",
        composition: { ...current.composition, stage: "lead_pending", reviewResults: normalizeReviewResults(observation.result), reviewFinishedAt: this.clock() },
      })) };
    }
    return { task: await this.#completeStage(task, phase, (current) => ({
      composition: { ...current.composition, stage: "final_pending", leadDecision: copy(observation.result), leadFinishedAt: this.clock() },
    })) };
  }

  async #advanceComposition(taskId, { mayExecutePending = true, reconcileRunning = false } = {}) {
    for (let transitions = 0; transitions < 12; transitions += 1) {
      let task = await this.state.getTask(taskId);
      if (!task?.composition || TERMINAL_STATES.has(task.state) || task.state === "needs_remediation") return task;
      if (task.composition.owner !== this.controllerId) return task;
      const stage = task.composition.stage;
      if (stage.endsWith("_running")) {
        if (!reconcileRunning) return task;
        const observed = await this.#inspectRunningStage(task);
        if (observed.waiting) return observed.task;
        task = observed.task;
        continue;
      }
      if (!mayExecutePending) return task;
      if (stage === "integration_pending") task = await this.#executeIntegration(task);
      else if (stage === "verification_pending") task = await this.#executeVerification(task);
      else if (stage === "review_pending") task = await this.#executeReview(task);
      else if (stage === "lead_pending") task = await this.#executeLead(task);
      else if (stage === "final_pending") return this.#finalize(task);
      else return task;
      if (task.state === "needs_remediation") return task;
    }
    throw new Error(`Task ${taskId} exceeded the bounded composition transition limit.`);
  }

  async finalizeTask(taskId, options = {}) {
    const task = await this.state.getTask(requiredText(taskId, "taskId"));
    if (!task) throw new Error(`Unknown engineering task ${taskId}.`);
    const sourceRevision = options.sourceRevision
      ?? task.composition?.sourceRevision
      ?? task.workerResult?.resultRevision
      ?? task.workerResult?.sourceRevision;
    await this.#claimComposition(taskId, { ...options, sourceRevision });
    return this.#advanceComposition(taskId);
  }

  async resume(runId) {
    requiredText(runId, "runId");
    await this.scheduler.reconcile(runId);
    const tasks = await this.state.listTasks(runId);
    const outcomes = [];
    for (const task of tasks) {
      if (task.workerResult && task.resultNotification?.status !== "delivered") {
        await this.#queueNotification(task.taskId);
        await this.#deliverNotification(task.taskId);
      }
      if (task.workerResult && !task.resultAcknowledgement && !task.completedAttempt?.incorporation) {
        await this.acknowledgeResult(task.taskId);
      }
      const current = await this.state.getTask(task.taskId);
      if (COMPOSITION_STATES.has(current.state) && current.composition?.owner === this.controllerId) {
        outcomes.push(await this.#advanceComposition(current.taskId, { reconcileRunning: true }));
      }
    }
    return outcomes;
  }

  async status(runId) {
    return this.state.listTasks(requiredText(runId, "runId"));
  }
}

export function controllerVerificationPassed(task) {
  return hasPassingVerification(task?.composition?.verificationResults || []);
}
