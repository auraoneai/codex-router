export const EVIDENCE_PACKET_SCHEMA_VERSION = 1;
export const EVIDENCE_PACKET_MAX_BYTES = 24 * 1024;
export const EVIDENCE_SUMMARY_MAX_BYTES = 8 * 1024;
export const EVIDENCE_EXCERPTS_MAX_BYTES = 8 * 1024;

const PASS_STATUSES = new Set(["passed", "pass", "success"]);
const BLOCKING_STATUSES = new Set(["failed", "fail", "skipped", "timeout", "timed_out", "missing", "not_run", "error"]);
const REVIEW_BLOCKING_DISPOSITIONS = new Set(["blocking", "unresolved", "needs_remediation", "rejected"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value, maximumBytes) {
  const text = String(value ?? "");
  if (byteLength(text) <= maximumBytes) return text;
  if (maximumBytes <= 0) return "";
  const suffix = "\n[truncated; raw artifact retained]";
  if (byteLength(suffix) >= maximumBytes) return Buffer.from(text).subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, "");
  const available = maximumBytes - byteLength(suffix);
  let prefix = Buffer.from(text).subarray(0, available).toString("utf8");
  while (prefix.endsWith("\uFFFD")) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

function stringArray(value, label, { itemBytes = 2 * 1024, maximumItems = 128 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  if (value.length > maximumItems) throw new Error(`${label} exceeds its ${maximumItems}-item safety bound.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item === "") throw new TypeError(`${label}[${index}] must be a non-empty string.`);
    if (byteLength(item) > itemBytes) throw new Error(`${label}[${index}] exceeds its byte bound; store it as an artifact.`);
    return item;
  });
}

function recordRevision(record) {
  for (const field of ["revision", "sourceRevision", "reviewedRevision", "resultRevision"]) {
    if (typeof record?.[field] === "string") return record[field];
  }
  return undefined;
}

function exactRevision(record, revision) {
  return recordRevision(record) === revision;
}

function verificationStatus(record) {
  if (record?.timedOut === true || record?.timeout === true) return "timeout";
  if (record?.skipped === true) return "skipped";
  if (record?.status !== undefined) return String(record.status).toLowerCase();
  if (Number.isSafeInteger(record?.exitCode)) return record.exitCode === 0 ? "passed" : "failed";
  return "missing";
}

function recordId(record, fallback = "unknown") {
  return record?.id ?? record?.verificationId ?? record?.reviewId ?? fallback;
}

function reviewBlocks(review) {
  if (review?.blocking === true) return true;
  if (REVIEW_BLOCKING_DISPOSITIONS.has(String(review?.disposition ?? "").toLowerCase())) return true;
  return Array.isArray(review?.findings) && review.findings.some((finding) => {
    if (finding?.resolved === true) return false;
    return finding?.blocking === true || ["critical", "high", "blocking"].includes(String(finding?.severity ?? "").toLowerCase());
  });
}

export function evaluateEngineeringAcceptance({
  revision,
  workerResults = [],
  verificationResults = [],
  reviewResults = [],
  requiredVerificationIds = [],
  requireReview = false,
  requireLeadAcceptance = true,
  leadDecision,
} = {}) {
  if (typeof revision !== "string" || revision === "") throw new TypeError("Acceptance revision must be a non-empty string.");
  if (!Array.isArray(workerResults) || !Array.isArray(verificationResults) || !Array.isArray(reviewResults)) {
    throw new TypeError("Acceptance result collections must be arrays.");
  }
  const blockers = [];
  const gates = {
    immutableRevision: true,
    workerClaimsRecorded: workerResults.length > 0,
    requiredVerification: false,
    review: false,
    leadAcceptance: false,
  };

  // A worker pass is deliberately never an acceptance gate. It only proves
  // that the claim was recorded for later deterministic verification.
  if (workerResults.length === 0) blockers.push("missing worker result");
  for (const result of workerResults) {
    if (!exactRevision(result, revision)) {
      gates.immutableRevision = false;
      blockers.push(`worker result ${recordId(result)} is stale or missing a revision`);
    }
  }

  const requiredIds = new Set(stringArray(requiredVerificationIds, "Required verification ids", { itemBytes: 256 }));
  const relevantVerifications = verificationResults.filter((result) => requiredIds.size === 0 || requiredIds.has(recordId(result)));
  for (const id of requiredIds) {
    if (!relevantVerifications.some((result) => recordId(result) === id)) blockers.push(`required verification ${id} is missing`);
  }
  if (relevantVerifications.length === 0) blockers.push("required verification is missing");
  for (const result of relevantVerifications) {
    const id = recordId(result);
    if (!exactRevision(result, revision)) {
      gates.immutableRevision = false;
      blockers.push(`verification ${id} is stale or missing a revision`);
    }
    const status = verificationStatus(result);
    if (!PASS_STATUSES.has(status)) {
      blockers.push(`verification ${id} is ${BLOCKING_STATUSES.has(status) ? status : `not passing (${status})`}`);
    }
    if (result?.required !== false && (result?.timeout === true || result?.skipped === true || result?.exitCode !== undefined && result.exitCode !== 0)) {
      blockers.push(`verification ${id} did not complete successfully`);
    }
  }
  gates.requiredVerification = relevantVerifications.length > 0 && !blockers.some((item) => item.startsWith("required verification") || item.startsWith("verification "));

  if (requireReview && reviewResults.length === 0) blockers.push("required review is missing");
  for (const review of reviewResults) {
    const id = recordId(review);
    if (!exactRevision(review, revision)) {
      gates.immutableRevision = false;
      blockers.push(`review ${id} is stale or missing a revision`);
    }
    const status = review?.status === undefined ? undefined : String(review.status).toLowerCase();
    if (status !== undefined && !new Set(["passed", "pass", "approved", "completed"]).has(status)) {
      blockers.push(`review ${id} is ${BLOCKING_STATUSES.has(status) ? status : `not passing (${status})`}`);
    }
    if (review?.timeout === true || review?.skipped === true) blockers.push(`review ${id} did not complete successfully`);
    if (reviewBlocks(review)) blockers.push(`review ${id} has unresolved blocking findings`);
  }
  gates.review = (!requireReview || reviewResults.length > 0) && !blockers.some((item) => item.startsWith("review ") || item === "required review is missing");

  if (requireLeadAcceptance) {
    if (!plainObject(leadDecision) || leadDecision.decision !== "accept") blockers.push("lead acceptance is missing");
    else if (!exactRevision(leadDecision, revision)) {
      gates.immutableRevision = false;
      blockers.push("lead acceptance is stale or missing a revision");
    }
    else gates.leadAcceptance = true;
  } else {
    gates.leadAcceptance = true;
  }

  const accepted = blockers.length === 0 && Object.values(gates).every(Boolean);
  return { accepted, revision, gates, blockers: [...new Set(blockers)] };
}

function fitJsonValue(value, maximumBytes) {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  if (byteLength(encoded) <= maximumBytes) return structuredClone(value);
  if (typeof value === "string") return truncateUtf8(value, maximumBytes - 2);
  return undefined;
}

function fitStringForPacket(packet, buildCandidate, value, maximumBytes) {
  const source = String(value ?? "");
  let low = 0;
  let high = Math.min(maximumBytes, byteLength(source));
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateValue = truncateUtf8(source, middle);
    const candidatePacket = buildCandidate(candidateValue);
    if (byteLength(JSON.stringify(candidatePacket)) <= EVIDENCE_PACKET_MAX_BYTES) {
      best = candidateValue;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function createEvidencePacket({
  runId,
  taskId,
  revision,
  summary = "",
  acceptance,
  unresolvedFailures = [],
  rawArtifactReferences = [],
  criticalExcerpts = [],
  acceptedResultReferences = [],
  reviewDisagreements = [],
  residualRisks = [],
  routingSummary,
  usageSummary,
  leadDecision,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (typeof runId !== "string" || runId === "") throw new TypeError("Evidence packet runId must be a non-empty string.");
  if (typeof taskId !== "string" || taskId === "") throw new TypeError("Evidence packet taskId must be a non-empty string.");
  if (typeof revision !== "string" || revision === "") throw new TypeError("Evidence packet revision must be a non-empty string.");
  if (!plainObject(acceptance) || acceptance.revision !== revision) {
    throw new Error("Evidence packet acceptance must be bound to the packet revision.");
  }
  const failures = stringArray(unresolvedFailures, "Unresolved failures");
  const artifactRefs = stringArray(rawArtifactReferences, "Raw artifact references", { itemBytes: 1024 });
  // Excerpts are intentionally compressible input. Accept a bounded raw value
  // here and truncate it into the aggregate 8 KiB packet allowance below.
  const excerpts = stringArray(criticalExcerpts, "Critical excerpts", { itemBytes: 1024 * 1024 });
  const packet = {
    version: EVIDENCE_PACKET_SCHEMA_VERSION,
    type: "EvidencePacket",
    runId,
    taskId,
    revision,
    generatedAt,
    acceptance: structuredClone(acceptance),
    unresolvedFailures: failures,
    rawArtifactReferences: artifactRefs,
    acceptedResultRefs: stringArray(acceptedResultReferences, "Accepted result references", { itemBytes: 1024 }),
    deterministicGateOutcomes: structuredClone(acceptance.gates || {}),
    reviewDisagreements: stringArray(reviewDisagreements, "Review disagreements"),
    residualRisks: stringArray(residualRisks, "Residual risks"),
    summary: "",
    criticalExcerpts: [],
    truncation: {
      summary: false,
      criticalExcerpts: false,
      omittedCriticalExcerptCount: 0,
    },
  };

  // Failures and raw references are the non-negotiable payload. Refuse the
  // packet if those cannot fit rather than silently dropping evidence.
  if (byteLength(JSON.stringify(packet)) > EVIDENCE_PACKET_MAX_BYTES) {
    throw new Error("Unresolved failures and raw artifact references exceed the evidence packet bound.");
  }

  for (const [key, value] of [["routingSummary", routingSummary], ["usageSummary", usageSummary], ["leadDecision", leadDecision]]) {
    const fitted = fitJsonValue(value, 2 * 1024);
    if (fitted === undefined) continue;
    const candidate = { ...packet, [key]: fitted };
    if (byteLength(JSON.stringify(candidate)) <= EVIDENCE_PACKET_MAX_BYTES) packet[key] = fitted;
  }

  packet.summary = fitStringForPacket(
    packet,
    (value) => ({ ...packet, summary: value }),
    summary,
    EVIDENCE_SUMMARY_MAX_BYTES,
  );
  packet.truncation.summary = packet.summary !== String(summary ?? "");

  let excerptBytes = 0;
  for (const excerpt of excerpts) {
    const remainingExcerptBytes = EVIDENCE_EXCERPTS_MAX_BYTES - excerptBytes;
    if (remainingExcerptBytes <= 0) break;
    const fitted = fitStringForPacket(
      packet,
      (value) => ({ ...packet, criticalExcerpts: [...packet.criticalExcerpts, value] }),
      excerpt,
      remainingExcerptBytes,
    );
    if (fitted === "") break;
    packet.criticalExcerpts.push(fitted);
    excerptBytes += byteLength(fitted);
  }
  packet.truncation.criticalExcerpts = packet.criticalExcerpts.length !== excerpts.length
    || packet.criticalExcerpts.some((excerpt, index) => excerpt !== excerpts[index]);
  packet.truncation.omittedCriticalExcerptCount = Math.max(0, excerpts.length - packet.criticalExcerpts.length);

  if (byteLength(packet.summary) > EVIDENCE_SUMMARY_MAX_BYTES) throw new Error("Evidence summary exceeded its byte bound.");
  if (packet.criticalExcerpts.reduce((total, item) => total + byteLength(item), 0) > EVIDENCE_EXCERPTS_MAX_BYTES) {
    throw new Error("Evidence excerpts exceeded their byte bound.");
  }
  if (byteLength(JSON.stringify(packet)) > EVIDENCE_PACKET_MAX_BYTES) throw new Error("Evidence packet exceeded its byte bound.");
  return createEngineeringRecord("EvidencePacket", packet);
}

export function evidencePacketByteLength(packet) {
  return byteLength(JSON.stringify(packet));
}
import { createEngineeringRecord } from "./contracts.mjs";
