import assert from "node:assert/strict";
import test from "node:test";

import {
  createEvidencePacket,
  EVIDENCE_EXCERPTS_MAX_BYTES,
  EVIDENCE_PACKET_MAX_BYTES,
  EVIDENCE_SUMMARY_MAX_BYTES,
  evidencePacketByteLength,
  evaluateEngineeringAcceptance,
} from "../src/engineering/evidence.mjs";

function passingAcceptance(overrides = {}) {
  return evaluateEngineeringAcceptance({
    revision: "rev-1",
    workerResults: [{ id: "worker-1", status: "pass", revision: "rev-1" }],
    verificationResults: [{ id: "unit", status: "passed", revision: "rev-1", exitCode: 0 }],
    requiredVerificationIds: ["unit"],
    reviewResults: [{ id: "review-1", revision: "rev-1", disposition: "approved", findings: [] }],
    requireReview: true,
    leadDecision: { decision: "accept", revision: "rev-1" },
    ...overrides,
  });
}

test("worker pass alone never becomes acceptance", () => {
  const result = evaluateEngineeringAcceptance({
    revision: "rev-1",
    workerResults: [{ id: "worker-1", status: "pass", revision: "rev-1" }],
    verificationResults: [],
    leadDecision: { decision: "accept", revision: "rev-1" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.gates.workerClaimsRecorded, true);
  assert.equal(result.gates.requiredVerification, false);
  assert.ok(result.blockers.includes("required verification is missing"));
});

test("passing checks, resolved review, and lead decision accept the exact revision", () => {
  const result = passingAcceptance();
  assert.equal(result.accepted, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(Object.values(result.gates).every(Boolean), true);
});

test("acceptance consumes the versioned engineering contract field names", () => {
  const result = evaluateEngineeringAcceptance({
    revision: "rev-contract",
    workerResults: [{ taskId: "task-1", status: "pass", resultRevision: "rev-contract" }],
    verificationResults: [{
      verificationId: "unit",
      sourceRevision: "rev-contract",
      exitCode: 0,
      timedOut: false,
    }],
    requiredVerificationIds: ["unit"],
    reviewResults: [{
      reviewId: "review-1",
      reviewedRevision: "rev-contract",
      disposition: "approved",
      findings: [],
    }],
    requireReview: true,
    leadDecision: { decision: "accept", revision: "rev-contract" },
  });
  assert.equal(result.accepted, true);
});

test("stale revisions and failed, skipped, timeout, or missing checks block acceptance", () => {
  for (const status of ["failed", "skipped", "timeout", "missing", "not_run"]) {
    const result = passingAcceptance({
      verificationResults: [{ id: "unit", status, revision: "rev-1" }],
    });
    assert.equal(result.accepted, false, status);
    assert.match(result.blockers.join("\n"), new RegExp(status, "u"));
  }
  const stale = passingAcceptance({
    verificationResults: [{ id: "unit", status: "passed", revision: "rev-old", exitCode: 0 }],
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.gates.immutableRevision, false);
  assert.match(stale.blockers.join("\n"), /stale/u);
  const absentNamedCheck = passingAcceptance({ requiredVerificationIds: ["unit", "integration"] });
  assert.equal(absentNamedCheck.accepted, false);
  assert.match(absentNamedCheck.blockers.join("\n"), /integration is missing/u);
});

test("blocking review findings and stale lead decisions cannot override deterministic proof", () => {
  const blockedReview = passingAcceptance({
    reviewResults: [{
      id: "review-1",
      revision: "rev-1",
      disposition: "approved",
      findings: [{ severity: "high", resolved: false, summary: "race" }],
    }],
  });
  assert.equal(blockedReview.accepted, false);
  assert.match(blockedReview.blockers.join("\n"), /blocking findings/u);
  const staleLead = passingAcceptance({ leadDecision: { decision: "accept", revision: "rev-old" } });
  assert.equal(staleLead.accepted, false);
  assert.match(staleLead.blockers.join("\n"), /lead acceptance is stale/u);
  const skippedReview = passingAcceptance({
    reviewResults: [{ id: "review-1", revision: "rev-1", status: "skipped", findings: [] }],
  });
  assert.equal(skippedReview.accepted, false);
  assert.match(skippedReview.blockers.join("\n"), /review review-1 is skipped/u);
});

test("evidence packets obey total, summary, and excerpt byte bounds", () => {
  const acceptance = passingAcceptance();
  const packet = createEvidencePacket({
    runId: "run-1",
    taskId: "task-1",
    revision: "rev-1",
    acceptance,
    summary: "summary ".repeat(5_000),
    criticalExcerpts: ["excerpt ".repeat(5_000)],
    unresolvedFailures: ["one residual failure remains"],
    rawArtifactReferences: ["artifacts/run-1/full-test.log#sha256=abc"],
    routingSummary: { route: "provider/model", retries: 1 },
    usageSummary: { measured: 1234 },
    leadDecision: { decision: "accept", revision: "rev-1" },
  });
  assert.ok(Buffer.byteLength(packet.summary, "utf8") <= EVIDENCE_SUMMARY_MAX_BYTES);
  assert.ok(packet.criticalExcerpts.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8"), 0) <= EVIDENCE_EXCERPTS_MAX_BYTES);
  assert.ok(evidencePacketByteLength(packet) <= EVIDENCE_PACKET_MAX_BYTES);
  assert.deepEqual(packet.unresolvedFailures, ["one residual failure remains"]);
  assert.deepEqual(packet.rawArtifactReferences, ["artifacts/run-1/full-test.log#sha256=abc"]);
  assert.match(packet.summary, /truncated; raw artifact retained/u);
  assert.equal(packet.truncation.summary, true);
  assert.equal(packet.truncation.criticalExcerpts, true);

  const escaped = createEvidencePacket({
    runId: "run-1",
    taskId: "task-1",
    revision: "rev-1",
    acceptance,
    summary: "\"\\\n".repeat(10_000),
    criticalExcerpts: ["\"\\\n".repeat(10_000)],
    rawArtifactReferences: ["artifacts/escaped.log"],
  });
  assert.ok(evidencePacketByteLength(escaped) <= EVIDENCE_PACKET_MAX_BYTES);
});

test("packet construction preserves critical failures and raw references or fails closed", () => {
  const acceptance = passingAcceptance();
  assert.throws(() => createEvidencePacket({
    runId: "run-1",
    taskId: "task-1",
    revision: "rev-1",
    acceptance,
    unresolvedFailures: Array.from({ length: 20 }, (_, index) => `${index}:${"x".repeat(1_900)}`),
    rawArtifactReferences: ["artifacts/raw.log"],
  }), /exceed the evidence packet bound/u);
  assert.throws(() => createEvidencePacket({
    runId: "run-1",
    taskId: "task-1",
    revision: "rev-1",
    acceptance: { ...acceptance, revision: "rev-old" },
  }), /bound to the packet revision/u);
});
