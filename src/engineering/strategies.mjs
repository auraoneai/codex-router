import { createHash } from "node:crypto";

export const ENGINEERING_STRATEGIES = Object.freeze([
  "single",
  "swarm",
  "pipeline",
  "arena",
  "interrogate",
]);

function error(code, message, details = {}) {
  const problem = new Error(message);
  problem.code = code;
  Object.assign(problem, details);
  return problem;
}

function stableId(...parts) {
  return createHash("sha256").update(parts.map((part) => JSON.stringify(part)).join("\0")).digest("hex").slice(0, 16);
}

function node(strategy, name, kind, extra = {}) {
  return { id: `${strategy}-${name}-${stableId(strategy, name, extra)}`, kind, ...extra };
}

function finalGates(strategy, predecessor, { verification = true, review = false } = {}) {
  const nodes = [];
  const edges = [];
  let prior = predecessor;
  if (verification) {
    const verify = node(strategy, "verify", "verify", { readOnly: true });
    nodes.push(verify);
    edges.push({ from: prior.id, to: verify.id, condition: "success" });
    prior = verify;
  }
  if (review) {
    const reviewNode = node(strategy, "review", "review", { readOnly: true });
    nodes.push(reviewNode);
    edges.push({ from: prior.id, to: reviewNode.id, condition: "success" });
    prior = reviewNode;
  }
  const accept = node(strategy, "accept", "accept", { readOnly: true });
  nodes.push(accept);
  edges.push({ from: prior.id, to: accept.id, condition: "success" });
  return { nodes, edges, acceptanceNodeId: accept.id };
}

function assertDisjointOwnership(entries) {
  const claims = [];
  for (const entry of entries) {
    for (const ownedPath of entry.ownedPaths || []) {
      const normalized = String(ownedPath).normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "").toLocaleLowerCase("en-US");
      if (
        !normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") ||
        normalized.startsWith("/") || /^[a-z]:\//u.test(normalized) || normalized.includes("/../") ||
        normalized.includes("\0") || normalized === ".git" || normalized.startsWith(".git/")
      ) {
        throw error("INVALID_STRATEGY_INPUT", `Invalid owned path ${ownedPath}.`);
      }
      const conflict = claims.find(({ path }) =>
        normalized === path || normalized.startsWith(`${path}/`) || path.startsWith(`${normalized}/`));
      if (conflict) {
        throw error("OWNERSHIP_OVERLAP", `${entry.id || entry.name} overlaps ${conflict.owner} at ${ownedPath}.`);
      }
      claims.push({ path: normalized, owner: entry.id || entry.name });
    }
  }
}

function graph(strategy, nodes, edges, acceptanceNodeId, extra = {}) {
  validateWorkflowGraph({ strategy, nodes, edges, acceptanceNodeId });
  return { version: 1, strategy, nodes, edges, acceptanceNodeId, ...extra };
}

export function compileSingle({ task, verification = true, review = false }) {
  if (!task) throw error("INVALID_STRATEGY_INPUT", "single requires a task.");
  const work = node("single", "work", "work", { task, ownedPaths: task.ownedPaths || [] });
  const gates = finalGates("single", work, { verification, review });
  return graph("single", [work, ...gates.nodes], gates.edges, gates.acceptanceNodeId);
}

export function compileSwarm({ slices, integrationOwner, verification = true, review = true }) {
  if (!Array.isArray(slices) || slices.length < 2 || !integrationOwner) {
    throw error("INVALID_STRATEGY_INPUT", "swarm requires at least two slices and an integration owner.");
  }
  assertDisjointOwnership(slices);
  const workers = slices.map((slice, index) => node("swarm", `work-${index}`, "work", {
    task: slice,
    ownedPaths: slice.ownedPaths || [],
  }));
  const integrate = node("swarm", "integrate", "integrate", { integrationOwner });
  const edges = workers.map((worker) => ({ from: worker.id, to: integrate.id, condition: "success" }));
  const gates = finalGates("swarm", integrate, { verification, review });
  return graph("swarm", [...workers, integrate, ...gates.nodes], [...edges, ...gates.edges], gates.acceptanceNodeId, {
    joinPolicy: "all-success",
    integrationOwner,
  });
}

export function compilePipeline({ stages, verification = true, review = true }) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw error("INVALID_STRATEGY_INPUT", "pipeline requires at least one stage.");
  }
  const byName = new Map();
  for (const stage of stages) {
    if (!stage.id || byName.has(stage.id)) throw error("INVALID_STRATEGY_INPUT", "Pipeline stage IDs must be unique.");
    byName.set(stage.id, stage);
  }
  for (const stage of stages) {
    for (const dependency of stage.dependencies || []) {
      if (!byName.has(dependency)) throw error("MISSING_DEPENDENCY", `Pipeline stage ${stage.id} depends on ${dependency}.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw error("CYCLIC_DEPENDENCY", `Pipeline contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byName.get(id).dependencies || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byName.keys()) visit(id);
  const nodes = stages.map((stage) => node("pipeline", stage.id, stage.kind || "work", { task: stage }));
  const nodeByStage = new Map(nodes.map((entry) => [entry.task.id, entry]));
  const edges = stages.flatMap((stage) => (stage.dependencies || []).map((dependency) => ({
    from: nodeByStage.get(dependency).id,
    to: nodeByStage.get(stage.id).id,
    condition: "success",
  })));
  const dependedOn = new Set(stages.flatMap((stage) => stage.dependencies || []));
  const leaves = stages.filter((stage) => !dependedOn.has(stage.id)).map((stage) => nodeByStage.get(stage.id));
  const synthesize = node("pipeline", "synthesize", "synthesize");
  for (const leaf of leaves) edges.push({ from: leaf.id, to: synthesize.id, condition: "success" });
  const gates = finalGates("pipeline", synthesize, { verification, review });
  return graph("pipeline", [...nodes, synthesize, ...gates.nodes], [...edges, ...gates.edges], gates.acceptanceNodeId, {
    joinPolicy: "all-success",
  });
}

export function compileArena({ brief, candidates, judge, maxCandidates = 4, deterministic = false, verification = true }) {
  if (deterministic) throw error("ARENA_NOT_JUSTIFIED", "Arena is not justified for deterministic work.");
  if (!brief?.baseRevision || !brief?.rubric || !Array.isArray(candidates) || candidates.length < 2) {
    throw error("INVALID_STRATEGY_INPUT", "arena requires a common base, rubric, and at least two candidates.");
  }
  if (candidates.length > maxCandidates) {
    throw error("CANDIDATE_LIMIT_EXCEEDED", `Arena candidate count exceeds ${maxCandidates}.`);
  }
  const candidateIds = new Set();
  for (const candidate of candidates) {
    if (!candidate?.id || candidateIds.has(candidate.id)) {
      throw error("INVALID_STRATEGY_INPUT", "Arena candidate IDs must be non-empty and unique.");
    }
    candidateIds.add(candidate.id);
    // Arena candidates intentionally may edit the same paths: each candidate
    // runs in a separate worktree and only the selected result is integrated.
    assertDisjointOwnership([{ ...candidate, id: candidate.id }]);
  }
  const judgeIdentities = new Set([judge?.agentId, judge?.id, judge?.model].filter(Boolean));
  const candidateIdentities = new Set(candidates.flatMap((candidate) =>
    [candidate.agentId, candidate.id, candidate.model].filter(Boolean)));
  if (judgeIdentities.size === 0 || [...judgeIdentities].some((identity) => candidateIdentities.has(identity))) {
    throw error("INVALID_STRATEGY_INPUT", "Arena requires an independent judge identity.");
  }
  const candidateNodes = candidates.map((candidate, index) => node("arena", `candidate-${index}`, "work", {
    candidateId: candidate.id,
    task: { ...candidate, brief, baseRevision: brief.baseRevision },
    isolatedWorkspace: true,
  }));
  const judgeNode = node("arena", "judge", "judge", { judge, rubric: brief.rubric, readOnly: true });
  const integrate = node("arena", "integrate", "integrate", { selectedOnly: true });
  const edges = candidateNodes.map((candidate) => ({ from: candidate.id, to: judgeNode.id, condition: "settled" }));
  edges.push({ from: judgeNode.id, to: integrate.id, condition: "selected" });
  const gates = finalGates("arena", integrate, { verification, review: false });
  return graph("arena", [...candidateNodes, judgeNode, integrate, ...gates.nodes], [...edges, ...gates.edges], gates.acceptanceNodeId, {
    joinPolicy: "all-settled",
  });
}

export function compileInterrogate({ revision, reviewers, minDistinctFamilies = 2, verification = true }) {
  if (!revision || !Array.isArray(reviewers) || reviewers.length < 2) {
    throw error("INVALID_STRATEGY_INPUT", "interrogate requires a fixed revision and at least two reviewers.");
  }
  const diversity = validateFamilyDiversity({ reviewerLineages: reviewers.map((reviewer) => reviewer.lineage || []) , minDistinctFamilies });
  if (!diversity.ok) throw error("REVIEW_FAMILY_CONFLICT", diversity.violations.join(" "));
  const reviewerIdentities = reviewers.map((reviewer) => reviewer.agentId || reviewer.id || reviewer.model);
  if (reviewerIdentities.some((identity) => !identity) || new Set(reviewerIdentities).size !== reviewers.length) {
    throw error("INVALID_STRATEGY_INPUT", "Interrogate reviewers must have unique identities.");
  }
  const reviewNodes = reviewers.map((reviewer, index) => node("interrogate", `review-${index}`, "review", {
    reviewer,
    revision,
    readOnly: true,
  }));
  const dedupe = node("interrogate", "dedupe", "dedupe", { readOnly: true });
  const remediate = node("interrogate", "remediate", "remediate");
  const edges = reviewNodes.map((review) => ({ from: review.id, to: dedupe.id, condition: "settled" }));
  edges.push({ from: dedupe.id, to: remediate.id, condition: "findings" });
  let predecessor = remediate;
  const gates = [];
  if (verification) {
    const verify = node("interrogate", "verify", "verify", { readOnly: true, join: "any" });
    gates.push(verify);
    edges.push({ from: dedupe.id, to: verify.id, condition: "no-findings" });
    edges.push({ from: remediate.id, to: verify.id, condition: "success" });
    predecessor = verify;
  }
  const finalReview = node("interrogate", "review", "review", { readOnly: true });
  const accept = node("interrogate", "accept", "accept", { readOnly: true });
  gates.push(finalReview, accept);
  if (!verification) {
    finalReview.join = "any";
    edges.push({ from: dedupe.id, to: finalReview.id, condition: "no-findings" });
    edges.push({ from: remediate.id, to: finalReview.id, condition: "success" });
  } else {
    edges.push({ from: predecessor.id, to: finalReview.id, condition: "success" });
  }
  edges.push({ from: finalReview.id, to: accept.id, condition: "success" });
  return graph("interrogate", [...reviewNodes, dedupe, remediate, ...gates], edges, accept.id, {
    joinPolicy: "all-settled",
    reviewedRevision: revision,
  });
}

export function compileStrategyGraph(options) {
  switch (options.strategy) {
    case "single": return compileSingle(options);
    case "swarm": return compileSwarm(options);
    case "pipeline": return compilePipeline(options);
    case "arena": return compileArena(options);
    case "interrogate": return compileInterrogate(options);
    default: throw error("INVALID_STRATEGY_INPUT", `Unknown engineering strategy ${options.strategy}.`);
  }
}

export function validateWorkflowGraph(workflow) {
  if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
    throw error("INVALID_STRATEGY_INPUT", "Workflow nodes and edges must be arrays.");
  }
  const ids = new Set(workflow.nodes.map((entry) => entry.id));
  if (ids.size !== workflow.nodes.length) throw error("INVALID_STRATEGY_INPUT", "Workflow node IDs must be unique.");
  if (!ids.has(workflow.acceptanceNodeId)) throw error("MISSING_DEPENDENCY", "Workflow acceptance node is missing.");
  const incoming = new Map(workflow.nodes.map((entry) => [entry.id, []]));
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw error("MISSING_DEPENDENCY", "Workflow edge references an unknown node.");
    incoming.get(edge.to).push(edge.from);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw error("CYCLIC_DEPENDENCY", `Workflow contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const predecessor of incoming.get(id)) visit(predecessor);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return true;
}

export function readyNodes(workflow, outcomes = {}) {
  const incoming = new Map(workflow.nodes.map((entry) => [entry.id, []]));
  for (const edge of workflow.edges) incoming.get(edge.to).push(edge);
  return workflow.nodes
    .filter((entry) => !outcomes[entry.id])
    .filter((entry) => {
      const predecessors = incoming.get(entry.id);
      if (predecessors.length === 0) return true;
      const satisfied = predecessors.map((edge) => {
        const outcome = outcomes[edge.from];
        if (!outcome) return false;
        if (edge.condition === "success") return outcome.status === "passed";
        if (edge.condition === "selected") return outcome.status === "passed" && outcome.selected;
        if (edge.condition === "findings") return outcome.status === "passed" && outcome.hasFindings;
        if (edge.condition === "no-findings") return outcome.status === "passed" && outcome.hasFindings === false;
        return ["passed", "failed", "blocked", "cancelled"].includes(outcome.status);
      });
      return entry.join === "any" ? satisfied.some(Boolean) : satisfied.every(Boolean);
    })
    .map((entry) => entry.id)
    .sort();
}

export function validateFamilyDiversity({
  authorLineage = [],
  reviewerLineages = [],
  minDistinctFamilies = 2,
  requireDifferentFromAuthor = false,
}) {
  const authorFamilies = new Set(authorLineage.map((entry) => entry.family).filter(Boolean));
  const reviewerFamilies = reviewerLineages.map((lineage) => {
    const attempts = lineage.filter((entry) => entry?.family);
    const served = [...attempts].reverse().find((entry) => entry.served === true || entry.status === "served" || entry.status === "success") || attempts.at(-1);
    return new Set(served?.family ? [served.family] : []);
  });
  const all = new Set(reviewerFamilies.flatMap((families) => [...families]));
  const violations = [];
  if (all.size < minDistinctFamilies) violations.push(`Review requires ${minDistinctFamilies} distinct actual model families; found ${all.size}.`);
  if (requireDifferentFromAuthor) {
    reviewerFamilies.forEach((families, index) => {
      const overlap = [...families].filter((family) => authorFamilies.has(family));
      if (overlap.length) violations.push(`Reviewer ${index} shares author family ${overlap.join(", ")}.`);
    });
  }
  return { ok: violations.length === 0, distinctFamilies: [...all].sort(), violations };
}

export function mergeFindings(reviewResults) {
  const merged = new Map();
  for (const review of reviewResults) {
    for (const finding of review.findings || []) {
      const fingerprint = finding.fingerprint || stableId(finding.invariant, finding.location, finding.reproducer);
      const current = merged.get(fingerprint) || { ...finding, fingerprint, reporters: [], evidence: [] };
      current.reporters.push(review.reviewerId);
      current.evidence.push(...(finding.evidence || []));
      current.reproducible ||= Boolean(finding.reproducible);
      current.blocking ||= Boolean(finding.blocking || finding.reproducible);
      merged.set(fingerprint, current);
    }
  }
  return [...merged.values()].map((finding) => ({
    ...finding,
    reporters: [...new Set(finding.reporters)].sort(),
    evidence: [...new Set(finding.evidence)].sort(),
  })).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

export function evaluateAcceptance({ targetRevision, gates = [], findings = [], familyDiversity, integrationRequired = false, integrationResult }) {
  const reasons = [];
  if (typeof targetRevision !== "string" || !targetRevision) reasons.push("Acceptance requires an immutable target revision.");
  if (!Array.isArray(gates) || gates.filter((entry) => entry.required !== false).length === 0) {
    reasons.push("Acceptance requires at least one deterministic gate.");
  }
  for (const gate of gates.filter((entry) => entry.required !== false)) {
    if (gate.status !== "passed") reasons.push(`Required gate ${gate.id} is ${gate.status}.`);
    else if (gate.revision !== targetRevision) reasons.push(`Required gate ${gate.id} is stale for ${targetRevision}.`);
  }
  for (const finding of findings) {
    if (finding.blocking || finding.reproducible) {
      if (finding.disposition !== "verified_fixed") {
        reasons.push(`Blocking finding ${finding.fingerprint || finding.id} is unresolved.`);
      } else if (finding.verifiedRevision !== targetRevision) {
        reasons.push(`Blocking finding ${finding.fingerprint || finding.id} was not verified fixed at ${targetRevision}.`);
      }
    }
  }
  if (familyDiversity && !familyDiversity.ok) reasons.push(...familyDiversity.violations);
  if (integrationRequired && (integrationResult?.status !== "integrated" || integrationResult?.revision !== targetRevision)) {
    reasons.push("Multi-worker output is not integrated at the target revision.");
  }
  return reasons.length ? { accepted: false, reasons } : { accepted: true, revision: targetRevision };
}

export function selectArenaWinner({ candidates, judge }) {
  const eligible = candidates.filter((candidate) =>
    Array.isArray(candidate.deterministicGates) && candidate.deterministicGates.length > 0 &&
    candidate.deterministicGates.every((gate) => gate.status === "passed"));
  if (!judge?.winnerId || judge.tied || !eligible.some((candidate) => candidate.id === judge.winnerId)) {
    return { status: "needs_adjudication", eligible: eligible.map((candidate) => candidate.id).sort() };
  }
  return { status: "selected", winnerId: judge.winnerId };
}
