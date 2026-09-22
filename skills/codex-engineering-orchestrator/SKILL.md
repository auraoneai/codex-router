---
name: codex-engineering-orchestrator
description: Operate Codex Router's opt-in Astra-led, multi-model engineering workflow for a custom (non-OpenAI) model. Use when the operator enables or requests engineering orchestration for a coding task.
---

# Codex Engineering Orchestrator

Use the repository's engineering runtime to coordinate a bounded, reviewable coding run. This skill supplies workflow guidance; it does not provide leases, persistence, isolation, retries, or acceptance by prompting alone. Those guarantees come from the policy, scheduler, state, worktree, artifact, and evidence adapters under `src/engineering/`.

## Respect the mode boundary

- Treat engineering orchestration as opt-in. Loading this skill is not enablement.
- Read the effective engineering policy before planning a run. If `enabled` is false and the operator did not ask to enable or use this workflow, continue with ordinary Codex behavior and do not call Jev or create an engineering run.
- An explicit request to enable or use the workflow authorizes activation for the requested scope. Once enabled, automate routine classification, dispatch, recovery, verification, and review within the configured limits.
- Preview the resolved preset, role routes, efforts, fallbacks, exclusions, and policy source before dispatch. Keep models and effort levels interchangeable through policy data rather than workflow code.

Use `src/engineering/policy-state.mjs` for the checked-in-default plus private-active-policy boundary, and `src/engineering/policy.mjs` to validate and resolve assignments. Reject unavailable models, unsupported explicit efforts, and invalid fallbacks before starting work. `default` means clear the scoped effort override; never send it upstream as a reasoning level.

## Keep leadership and routing honest

- Keep `gpt-6-astra` on Codex's native signed-in path as the default outer lead. Resolve the policy's top-level `lead` through `resolveEngineeringLead()`; never pass `lead_engineer` through child-agent assignment resolution or invent a Prism Astra route. Resolve Sol only through `deputy_lead`. Do not silently replace an active native lead; another outer lead is valid only when the operator explicitly selects it for a new run.
- Use Astra for the initial brief, acceptance criteria, architecture decisions that need principal judgment, and the final revision-bound decision. Let the coordinator and scheduler handle routine worker events between those phases.
- Use `src/engineering/prism-decisions.mjs` as the authenticated Prism decision adapter for Jev assessments; never add a direct TypeSafe, Vercel, or OpenRouter client to this workflow. If that adapter is unavailable or cannot validate its contract, record Jev as unavailable and use conservative deterministic routing. Jev classifies bounded questions; it does not create the task graph, write implementation plans, dispatch workers, summarize prose, or accept results.
- Prefer Sonnet 5 and GPT-5.6 for substantial implementation. Keep Kimi K3 sparse and optional: use it only when explicitly selected, enabled as an optional specialist, or reached through an intentional later fallback.
- Every assignment that resolves to DeepSeek V4.1 Flash must carry `deepseek-non-modal-fallback`. On a confirmed 429 or capacity/busy failure, reconcile the attempt, cool down that route, and advance without another orchestration retry on the same saturated path. The default recovery order is a verified healthy full GLM route outside Modal, then GPT-5.6 Sol, then Sonnet 5. Reject dispatch when no eligible non-Modal recovery route remains.

Record the selected role, exact route, provider, model family, requested and effective effort, resolution source, rejected candidates, fallback order, and policy revision in the strict engineering records. Put the full secret-free Jev gateway attempts, outcomes, ambiguity state, and total-deadline result in a content-addressed artifact and retain its hash reference in the task's `artifactRefs`; the routing decision records the matching assessment ID and `source`. Do not add unknown fields to strict records. A catalog entry alone does not prove current execution eligibility.

## Execute through runtime contracts

1. Have the lead or deputy turn the request into explicit tasks, dependencies, owned paths, acceptance criteria, verification requirements, and attempt limits. Use the versioned records in `src/engineering/contracts.mjs`.
2. Compile the appropriate `single`, `swarm`, `pipeline`, `arena`, or `interrogate` graph through `src/engineering/strategies.mjs`. Do not use multi-model voting to overrule a reproducible defect or failed deterministic check.
3. Register and admit work through `src/engineering/scheduler.mjs`. Convert the immutable policy snapshot into an execution record with `src/engineering/execution-binding.mjs`, then dispatch, inspect, resume, and cancel through `src/engineering/codex-executor.mjs`. Persist assignment intent before dispatch; bind the actual thread, turn, worktree, operation ID, lease, and fencing token; then persist the result before notification. Reconcile an ambiguous or interrupted attempt before redispatch. Treat in-memory state adapters as test fixtures, never as production durability.
4. Give concurrent writers disjoint owned paths and isolated Git worktrees through `src/engineering/worktrees.mjs`. Only the integrator mutates the integration worktree. Reviewers inspect a fixed revision. Never clean up a dirty, foreign, unreconciled, or unrecorded worktree.
5. Schedule from ready work, actual shared runtime availability, explicit operator limits, and measured provider capacity. Large graphs run in waves; no small fixed per-parent cap is part of this workflow. When concurrency is material, prove it from overlapping child start and finish intervals.

Use only lifecycle operations that the installed Codex host actually offers. If start, inspect, resume, cancel, model binding, effort binding, or worktree isolation is unavailable, report that exact capability gap and operate in assisted mode. Do not claim unattended durability because an instruction asks agents to persist.

## Gate acceptance with evidence

- Treat every worker success or `pass` as an unverified claim.
- Run every required deterministic verification on the exact candidate or integrated revision. A skip, timeout, missing result, nonzero exit, stale revision, or dirty-tree mismatch cannot pass.
- Require applicable independent review on that same revision, preserve blocking findings, and enforce configured model-family diversity. Multi-worker changes require final checks after integration.
- Store raw logs and other large results as content-addressed artifacts through `src/engineering/artifacts.mjs`; pass references and hashes instead of large transcripts.
- Run a pre-lead evaluation with `evaluateEngineeringAcceptance({ requireLeadAcceptance: false })`. If it passes, build the bounded packet with `createEvidencePacket()` from `src/engineering/evidence.mjs` and send that revision-bound packet to Astra. After Astra returns a revision-bound `leadDecision`, rerun `evaluateEngineeringAcceptance()` with that decision and only then call `acceptEngineeringTask()` from `src/engineering/state.mjs`.
- Preserve unresolved failures and raw artifact references in the packet. It is limited to 24 KiB, with at most 8 KiB for its summary and 8 KiB for critical excerpts. A stale lead decision, unresolved blocker, failed deterministic gate, or missing required review keeps the task out of `accepted`.

Return the final state, integrated revision, gate outcomes, unresolved risks, actual routing and effort choices, fallback events, usage attribution when measured, and retrievable artifact references. Distinguish observed runtime evidence from model claims and configured intent.
