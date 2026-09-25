# MISSION: BUILD AN ASTRA-LED, PRISM/JEV-ROUTED MULTI-MODEL ENGINEERING STACK FOR CODEX

## Research-backed Codex integration specification

**Research date: 2026-09-21 America/Los_Angeles (2026-09-22 UTC).**
**Follow-up audit:** refreshed against the implemented Codex Router runtime and
the deployed multi-provider Jev revision on 2026-09-22 UTC.
**Status: complete, deployed, installed, and opt-in by default.** The production
runtime, graph executor,
durable scheduler/worktree composition, CLI run surface, pinned/adaptive policy,
lead risk gate, and telemetry described below now exist. Live rollout evidence
is recorded in the checklists. Routes that failed a live probe remain explicitly
unavailable and are not declared healthy from catalog presence.

The model access layer is already substantially present. Build the engineering
workflow above Codex's execution lifecycle, reuse Prism's existing decision and
persistence primitives, and preserve Codex Router as the shared transport plane.
Do not build another gateway, provider registry, or independent Jev service.

**Models and reasoning effort are interchangeable configuration.** Astra, Sol,
Gemini, GLM, Kimi, DeepSeek and Claude assignments below are starting presets,
not permanent dependencies. The operator must be able to change a role's model,
provider route, effort and fallback order without editing workflow code. The
same workflow must continue to work with any eligible replacement.

**Operator preference: use Kimi K3 sparingly.** Sonnet 5 and GPT-5.6 are the
default substantial-implementation choices. Keep Kimi available as an optional
specialist or explicitly enabled later fallback, not a routine worker assignment
or mandatory escalation step. This is a routing preference, not a higher effort
setting for Kimi or a claim that it cannot perform the work.

### 1. Findings that change the original implementation plan

1. **Astra is native Codex.** The local native catalog contains `gpt-6-astra`.
   It is not a Prism model. Prism's `cli-configs/codex-kiro` explicitly delegates
   native model requests back to Codex/Router. Keep Astra as the native parent;
   do not replace the parent model with `prism-auto` or invent
   `kiro-prism/gpt-6-astra`.
2. **Jev is already implemented in Prism.** Authenticated
   `POST https://prism.auraone.ai/v1/decisions` accepts a provider-neutral typed
   request and uses TypeSafe's System One endpoint. Extend its engineering
   question policy and client integration; do not recreate the TypeSafe adapter.
3. **Jev classifies; code chooses and executes.** It cannot write a task graph,
   implementation plan, evidence summary, or architecture explanation. Astra or
   Sol decomposes work; Jev evaluates bounded questions; deterministic policy
   resolves roles, eligible routes, review requirements and admission.
4. **Prism already has adaptive routing and persistence primitives.** Reuse
   `SemanticRoutingAssessment`, adaptive readiness/candidate metadata,
   `child_state.py`, and `task_ledger.py`. These are not proof of a public Codex
   execution API, worktree manager, or complete engineering scheduler.
5. **Model availability and task readiness are different.** A catalog entry or
   an offered agent type proves publication. It does not prove current key
   entitlement, live inference, tool execution, native/routed handoff, or review
   quality. Those remain rollout tests.
6. **Transport recovery is not task recovery.** Existing retries cannot prove
   that a partially executed coding task is safe to repeat. Reconcile child
   status, worktree changes and side effects before creating another writer.
7. **A Jev answer-quality score cannot pass tests.** The existing Prism semantic
   verifier is not demonstrated to cover all streaming Codex Responses paths.
   Engineering acceptance must use runtime evidence on the exact integrated
   revision, regardless of that score.
8. **Concurrency needs reconciliation.** Router currently publishes a managed
   six-thread default. This session exposes a different shared runtime capacity.
   Neither number is a new architectural cap. Discover available capacity,
   honor explicit operator limits, and schedule large graphs in waves.

### 2. Source map and reuse boundaries

Kiro Prism documentation authority for this work is limited to:

- `/Users/gurbakshchahal/kiro-prism/README.md`
- `/Users/gurbakshchahal/kiro-prism/SETUP.md`
- `/Users/gurbakshchahal/kiro-prism/LLM.md`
- `/Users/gurbakshchahal/kiro-prism/API.md`

Use the actual source to resolve code behavior; do not read additional Prism
Markdown documents for this integration without a changed user instruction.

**Codex Router seams already inspected:**

- `src/model-registry.mjs`: authoritative provider/model records and runtime
  composition. Engineering roles reference identities from here.
- `src/codex-agent-catalog.mjs`: `routedAgentDefinition()` and
  `syncRoutedCodexAgents()` publish model-pinned Codex agent definitions.
- `src/multi-agent-state.mjs`, `src/subagent-routing.mjs`: operator selection,
  verified eligibility, capability filtering and bounded transport fallback.
  `subagent-auto-policy.mjs` controls compatibility probes, not engineering policy.
- `src/namespace-relay.mjs`: spawn model inheritance and explicit override
  preservation. Its older blanket-pinning comment disagrees with the current
  implementation and `test/subagent-model-inherit.test.mjs`; executable behavior
  and the current tool schema govern integration.
- `src/subagent-turns.mjs`, `src/subagent-completion.mjs`: turn accounting and
  collaboration completion handling. HTTP turn observation is not a durable
  task-completion oracle.
- `src/codex-app-tools.mjs`: app-owned thread/worktree tool schemas. A checked-in
  schema is not proof the current session offers that tool.
- `src/upstream-retry.mjs`, `src/model-failover.mjs`, `src/router-health.mjs`:
  transport retries, selected failover cases, cooldowns and health reporting.
- `src/usage-events.mjs`, `src/response-usage.mjs`: existing usage and request
  correlation. Extend attribution; preserve measured-versus-estimated usage.
- `src/config-manager.mjs`: managed client configuration and the six-thread
  default. Preserve unrelated settings and existing login/routing boundaries.

**Prism seams already inspected:**

- `kiro_prism/main.py`: authenticated `/v1/decisions`, adaptive dispatch and
  provider error handling.
- `kiro_prism/decision_types.py`, `kiro_prism/typesafe_upstream.py`: strict
  decision request/response/error contracts and the existing TypeSafe, Vercel
  and OpenRouter Jev fallback adapter.
- `kiro_prism/jev_client.py`: versioned question pack and
  `SemanticRoutingAssessment`, including task family, difficulty, failure impact,
  verification difficulty, parallelizability and frontier-model need.
- `kiro_prism/adaptive_model_registry.py`, `kiro_prism/adaptive_routing.py`:
  existing model capabilities, supervisor/worker eligibility and selection policy.
- `kiro_prism/child_state.py`: assignment persistence before dispatch, a dispatch
  callback, durable results, attachment, incorporation and acknowledgement.
- `kiro_prism/task_ledger.py`: durable task checkpoints and completion evidence.
  Bind the new engineering state to this mechanism rather than creating a
  competing authoritative task database.
- `kiro_prism/usage_tracker.py`, `kiro_prism/provider_telemetry.py`: request,
  route and adaptive-outcome telemetry.

The audit used overlapping independent Router and Prism inspections. The
follow-up then deployed the hardened Prism revision and exercised the bounded
live probes recorded below. Credentials were installed through protected,
owner-only paths; their values were never added to source, command arguments or
logs. Current source, deployment identity, health, decision provenance and live
route responses were independently checked without reading `.env` contents.

### 3. Target architecture and ownership

```text
Codex native parent: gpt-6-astra
  initial engineering brief + acceptance criteria
                     |
                     v
Codex engineering coordinator / deputy: routed GPT-5.6 Sol
  constrained context + existing Codex execution tools
                     |
      +--------------+----------------+
      |                               |
      v                               v
Prism decision/policy adapter     Durable engineering checkpoint
  existing /v1/decisions          reuse child_state + task_ledger
  Jev typed assessment           task graph, attempts, artifacts
      |                               |
      +--------------+----------------+
                     |
                     v
Codex lifecycle adapter + deterministic scheduler
  native collaboration or verified worktree-thread execution
  role/model binding, leases, admission, cancellation, recovery
                     |
                     v
Existing Codex Router -> existing providers / Kiro Prism -> workers
                     |
                     v
Sol/Sonnet integration -> remote deterministic checks -> independent review
                     |
                     v
bounded, revision-bound evidence packet -> native Astra final judgment
```

The coordinator performs routine orchestration and remediation so worker events
do not repeatedly require Astra to decide the next step. The scheduler enforces
the graph and gates; coordinator prose cannot bypass them. The router continues
to relay tools to Codex. Never execute shell, filesystem or collaboration tools
inside the HTTP model gateway.

**First implementation gate: prove the installed Codex lifecycle interface.**
The session's `collaboration.spawn_agent` offers model-pinned `agent_type`
choices; it does not currently offer an arbitrary `model` or per-child `cwd`
argument. Resolve the selected route to an offered agent type. Do not pass
unsupported arguments or assume a string visible in source is an installed tool.
Other Codex versions may expose explicit model overrides: discover and validate
them, preserving the existing namespace/model guards.

**Nested delegation precedence is an unresolved compatibility gate.**
`injectSessionModelForSpawnCalls()` currently injects the routed parent's model
when a spawn lacks `model`; it does not exempt an explicit `agent_type`. Therefore
prove both native Astra -> routed Sol and routed Sol -> a different model selected
by generated agent type. The generated role file alone does not establish which
model wins over an injected override. If the parent injection wins, repair the
relay's advertised-role precedence with regression tests before enabling nested
heterogeneous work. Do not pass a hidden `model` argument to bypass the host schema.

Use native collaboration for bounded read-only work and work whose isolation is
actually provided. For concurrent coding, prefer app-managed worktree threads
when those tools are offered. Otherwise use a verified supported Codex process or
app-server interface running in an explicitly created Git worktree. Inspect that
installed interface and prove start, result, follow-up, cancel and resume before
choosing it. Do not assume an MCP server can call the chat's collaboration tools,
import Cursor APIs, or invent a Codex SDK method.

A Codex skill/agent instruction layer supplies workflow guidance, and a small
tool adapter supplies checkpoint/policy access. Hard guarantees require runtime
enforcement. If the available host exposes only model-issued tool calls, label
that mode as assisted coordination until lifecycle event/resume support is
proven; do not advertise unattended durable execution based on prompting alone.

### 4. Actual route identities and engineering roles

Keep three separate identities: engineering role, Router model slug, and Prism
upstream model ID. Resolve provider, context, tools, vision, effort and selected
credential readiness from existing catalogs. Do not infer capability from a name.

Observed usable publication identities (live inference remains untested here):

- Native lead: `gpt-6-astra` through the signed-in native Codex path.
- Fast worker: `gemini-api/models/gemini-3.8-flash` through Google's direct
  Gemini API. The route is checked in for clean installs and becomes an exact
  Codex agent binding after its local collaboration proof is current;
  Prism also documents upstream `gemini-3.8-flash`.
- Mechanical worker: `cloudflare-workers-ai/glm-5.3-flash` in the current agent
  list; Prism also documents upstream `glm-5.3-flash` and `glm-5.3`.
- Optional specialist: `kiro-prism/kimi-k3`, upstream `kimi-k3`.
- Debugger: `kiro-prism/deepseek-v4.1-flash`, upstream `deepseek-v4.1-flash`.
- Balanced coder/integrator: `kiro-prism/claude-sonnet-5`, upstream
  `claude-sonnet-5`.
- Deputy/integrator/reviewer: native Codex `gpt-5.6-sol` through the signed-in
  OpenAI path. It does not traverse Kiro Prism.
- Premium reviewer: `kiro-prism/claude-opus-5.5`, upstream `claude-opus-5.5`.
- Additional worker tiers: `kiro-prism/gpt-5.6-luna` and
  `kiro-prism/gpt-5.6-terra`, when eligible for the task.

Do not invent `cloudflare-workers-ai/glm-5.3` merely from its family: that exact
agent type was not offered in this session. Full GLM 5.3 has other offered routes;
verify its intended Cloudflare lane in Prism and publish/prove the matching
Router route if required. Treat direct and Prism-served versions as distinct
routes to potentially the same model family, not independent reviewers.

The engineering preview must show the native `gpt-6-astra` lead explicitly.
Every exact `gpt-5.6-sol` candidate in the engineering policy is a native Codex
child route with an independently editable effort. Claude Opus 5 and Claude
Sonnet 5 retain their `kiro-prism/` route identities. A native child launch uses
Codex's `openai` model provider and must not attach router provider headers.

Prism's adaptive ten-model pool already includes the requested worker families.
Its existing Qwen/Grok adaptive exclusions remain unchanged. The Router's
`kiro-prism/auto` record currently names upstream `auto`; do not assume that
means the separately documented `prism-auto` route. Resolve/prove an adaptive
publication explicitly before relying on it.

Create one versioned engineering role policy, proposed at
`config/engineering-policy.json`. The names below are role aliases in that policy,
not additional provider registrations:

- `lead_engineer`: Astra by default; Sol may perform delegated deputy duties.
  An explicit operator choice can select another eligible lead for a new run.
  Do not silently replace an active parent when native Astra is unavailable.
- `architecture`: Sol and Opus alternatives; Astra adjudicates major forks.
- `fast_general_worker`, `repo_explorer`, `prose_docs`, `synthesizer`: Gemini
  Flash, then eligible GLM Flash, then Sonnet.
- `mechanical_worker`: GLM Flash, then Gemini Flash.
- `general_coder`: Gemini Flash, Sonnet, then eligible GPT-5.6 worker tier.
- `complex_coder`: Sonnet, Sol, then an eligible full GLM route. Kimi is an
  optional later fallback only when enabled for the run.
- `debugger`: DeepSeek Flash, then healthy non-Modal full GLM, Sol, Sonnet.
- `test_author`: Gemini Flash, with DeepSeek optional for difficult test reasoning;
  whenever DeepSeek is selected, attach the mandatory non-Modal fallback below.
- `reviewer`: Sol, Opus, full GLM; Kimi is an optional alternate perspective.
  Require a different family from the
  author for high-risk review and never let an author review their own patch.
- `integrator`, `deputy_lead`: Sol, then Sonnet.

Policy stores ordered route references, family-diversity requirements, allowed
effort, minimum capabilities, task budget, review rules and disable overrides.
It must contain no API keys, duplicate endpoints, invented prices or fabricated
fast-model equivalents. Validate all references against current eligible models
and offered execution bindings before dispatch; record rejected candidates.

#### 4.1. Model and effort controls are a first-class product requirement

Expose one coherent policy editor/configuration with these operations:

- Pick any currently eligible model/provider route for a role, including the
  lead, deputy, implementer, debugger, reviewer and synthesizer.
- Choose that model's advertised reasoning effort independently for every role
  and every fallback candidate; show `default` when no explicit effort is desired.
- Reorder, replace, temporarily disable or remove candidates without editing
  scheduler code or changing provider credentials.
- Apply a named preset such as `fast`, `balanced` or `deep-review`; presets are
  editable policy bundles, not additional model aliases or capability claims.
- Override a model/effort for one task or retry without changing another task,
  the whole role, the native parent or the machine-wide child defaults.
- Preview the resolved route, requested/effective effort, fallback order and
  eligibility reasons before activation. Show the configuration source that won.

The existing Router already supports per-model child effort through
`subagentEffort()` / `setSubagentEffort()` in `src/multi-agent-state.mjs`,
`model_reasoning_effort` in generated agent definitions, and
`control subagents effort <model-slug> <level|default>`. Reuse that capability
for operator defaults. This command is an existing persistent per-model setting,
not a safe mechanism for changing each concurrent task's effort.

Example **proposed engineering configuration**, not an already installed schema:

```json
{
  "version": 1,
  "activePreset": "balanced",
  "roles": {
    "lead_engineer": {
      "primary": { "model": "gpt-6-astra", "effort": "default" }
    },
    "complex_coder": {
      "primary": { "model": "kiro-prism/claude-sonnet-5", "effort": "high" },
      "fallbacks": [
        { "model": "gpt-5.6-sol", "effort": "default" }
      ]
    },
    "debugger": {
      "primary": { "model": "kiro-prism/deepseek-v4.1-flash", "effort": "default" },
      "fallbacks": [
        { "model": "cloudflare-workers-ai/glm-5.3", "effort": "high" },
        { "model": "gpt-5.6-sol", "effort": "default" },
        { "model": "kiro-prism/claude-sonnet-5", "effort": "high" }
      ],
      "capacityFailurePolicy": "deepseek-non-modal-fallback"
    },
    "reviewer": {
      "primary": { "model": "kiro-prism/claude-sonnet-5", "effort": "max" },
      "fallbacks": [
        { "model": "kiro-prism/claude-opus-5.5", "effort": "max" }
      ],
      "requireDifferentFamilyFromAuthor": true
    }
  }
}
```

For example, change `complex_coder.primary` from Sonnet/high to Sol/default,
or change the Sonnet review effort from `max` to `high`, using only policy data.
If the implementer and reviewer resolve to the same family, choose an eligible
independent reviewer before dispatch. Validate the illustrative efforts against
the current route capabilities; do not assume every provider exposes the same
levels or that a level has the same cost/reasoning behavior across models.

**Required resolution order for new engineering tasks:** explicit task/attempt
override -> selected role candidate's model/effort -> operator per-model child
default -> advertised route default. Workspace overrides take precedence over
the selected preset when compiling the role policy. `default` explicitly clears
an effort override at that scope and resolves through documented defaults; it
must never be serialized to a provider as an invented reasoning level. Record
whether the effective effort was inherited, explicitly selected or unknown.

This precedence is **new integration work**, not current Router behavior. In
`src/router.mjs`, a configured child effort overwrites the incoming
`reasoning.effort` for requests marked `x-openai-subagent`. A generated role's
effort alone therefore cannot guarantee task isolation. Add a scoped, validated
engineering execution binding/override so two simultaneous tasks can use the
same model at different efforts without mutating shared defaults. Preserve
legacy override behavior for non-engineering requests. If the installed host
offers no per-spawn effort argument, use verified role-specific execution
configuration or an authenticated adapter binding; never invent tool arguments.

Validate against the actual route's `reasoningLevels`/supported effort metadata.
If the route is fixed-effort, accepts no reasoning control, or lacks known effort
metadata, present that limitation and use its default. Refuse an unsupported
explicit effort before dispatch; do not silently downgrade it or force a
generic global list. A fallback carries its own effort setting and must not
inherit a level valid only on the failed model. Prism/provider translation still
owns the wire representation; record what was requested and what was actually
accepted where observable.

Policy updates are atomic and versioned. They apply to new task assignments;
running attempts keep their resolved model/effort and policy snapshot. A deliberate
change to a running task first reconciles/stops its current attempt and resumes
from a recorded checkpoint. Changing the lead model requires the supported Codex
model-selection/new-session path, not an assumed hot swap of an active parent.
Catalog refresh and profile changes preserve user settings, and stale generated
role bindings must be rejected or refreshed before the next dispatch.

### 5. Jev contract and credential integration

Use the already-authenticated Prism decision lane as the default. Codex receives
the existing Prism access path, not a TypeSafe provider credential. Keep the
provider keys server-side using existing secure configuration/deployment paths.
The documented TypeSafe production SecureString location is
`/kiro/prism/typesafe-api-key`; the follow-up inspected fallback-key pass-through
in `docker-compose.yml` and `docker-run.sh`. Do not assert an uninspected SSM
location or hosted deployment state for the other keys.

The existing setup uses `PRISM_TYPESAFE_ENABLED`, server-side
`PRISM_TYPESAFE_API_KEY`, and default `jev-latest`. Classification defaults are
1.5 seconds and 65,536 state bytes. Preserve these as existing defaults, then
measure engineering routing performance before tuning them.

**Important wire difference:** Prism's request uses `question` and explicit
`options`. The updated `build_upstream_request_body()` emits `question` and
criteria for all three lanes, adds `instructions` for OpenRouter, and adds
explicit `options` for OpenRouter choice questions. Current public examples
may use `instructions`; preserve the inspected adapter and operator-reported
successful wire behavior, then cover all question types with contract tests.
Prism currently requires object-shaped `state`, permits only provider `typesafe`,
and rejects slash-containing model IDs. Do not send the pasted OpenRouter SDK
envelope or `typesafe/jev-1.13` to Prism's existing decision endpoint.

Example body matching the inspected Prism contract (illustrative task state):

```json
{
  "provider": "typesafe",
  "model": "jev-latest",
  "request_id": "engineering-task-001-assessment-1",
  "state": {
    "objective": "Repair the failing parser regression",
    "facts": ["A targeted regression currently fails"],
    "scope": ["src/parser.mjs", "test/parser.test.mjs"]
  },
  "questions": {
    "task_family": {
      "type": "choice",
      "question": "Which kind of engineering work is required?",
      "options": ["coding_debugging", "coding_implementation", "coding_review"],
      "criteria": {
        "coding_debugging": "Diagnose and repair existing incorrect behavior",
        "coding_implementation": "Implement new specified behavior",
        "coding_review": "Inspect a change without modifying it"
      }
    },
    "parallelizable": {
      "type": "noul",
      "question": "Can independent tasks run without conflicting writes?"
    }
  }
}
```

Reuse the existing complete question pack rather than treating this small example
as its replacement. Extend/version the pack only for missing engineering
dimensions such as scope breadth and review risk. Map score rubrics explicitly;
a rubric position is not a probability. Preserve choice distributions,
confidence and Noul probability as separate values.

The deterministic policy computes model candidates, fallback chain, parallelism,
strategy and verification requirements from the assessment plus actual repository
facts and runtime capacity. It must not ask Jev to invent model IDs, count free
slots, authorize commands or declare tests successful. Insufficient context or
low confidence routes to a conservative existing role, usually Sol, with the
reason recorded. It does not remove security or verification gates. A Jev outage
is distinct from an uncertain valid answer.

Evaluate Jev once per new task/meaningful rerouting event, reuse the decision for
unchanged retries, and bind it to the objective/context hash, question version,
policy version and candidate snapshot. Answer-dependent questions require a
subsequent evaluation. Use a labeled engineering evaluation set, including
ambiguous and security-sensitive tasks, before choosing production thresholds.

**Multi-provider Jev fallback is now implemented in the existing Prism adapter.**
Reuse it behind the same decision endpoint; do not build another chain in Codex:

- Primary existing route: TypeSafe `POST /v1/systemone`, model `jev-latest`,
  behind Prism's decision API.
- Existing Vercel fallback: `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone`,
  model `typesafe-ai/jev`.
  This preserves TypeSafe-shaped questions/answers. Vercel's separate
  `/v1/evaluate` uses Boolean/probability names and requires normalization.
- Existing OpenRouter fallback: `POST https://openrouter.ai/api/alpha/decisions`,
  model `typesafe/jev-1.13`. The adapter sends a direct JSON body; Codex must not
  wrap it in the SDK's `decisionsRequest` argument shape.

Verified in current source:

- `config.py` exposes `PRISM_JEV_FALLBACK_ORDER` (default
  `typesafe,vercel,openrouter`), `PRISM_VERCEL_GATEWAY_API_KEY`,
  `PRISM_VERCEL_GATEWAY_BASE_URL`, `PRISM_VERCEL_GATEWAY_MODEL`,
  `PRISM_OPENROUTER_API_KEY`, `PRISM_OPENROUTER_BASE_URL`, and
  `PRISM_OPENROUTER_MODEL`. Use these existing settings instead of new synonyms.
- `main.py` passes them into the shared `TypeSafeUpstream` instance used by the
  decision lane and Jev classifier. Lane enablement remains explicit.
- `JevProviderEndpoint` resolves the correct path/model/key for each gateway.
  The ordered chain skips endpoints missing configuration; Vercel can serve
  when the native TypeSafe key is absent. There is no need to expand the public
  request's `provider` field just to use the existing internal fallback chain.
- Both launch files pass the order, keys, base URLs and models through. The
  pinned production image described below was restarted with this wiring and
  reports all three Jev gateways ready without exposing their keys.
- Health output lists configured provider readiness and order without keys;
  readiness means configuration checks, not an active credential/inference probe.
- `tests/test_jev_multi_fallback.py` covers native success, Vercel recovery from
  429/5xx, OpenRouter after earlier failures, custom ordering, skipped
  unconfigured endpoints, exhaustion and secret-free health output.

**Verification carried forward and extended:** all three vendor endpoints
returned HTTP 200 with calibrated probabilities in the original verification;
the supplied keys matched protected configuration, deployment pass-through was
updated, and 145 automated Prism checks passed. The follow-up independently
matched the running revision and image digest, verified healthy gateway state,
and sent a live authenticated Noul/Choice/Score request through the deployed
Prism decision endpoint. Do not repeat credential setup or paid probes solely
because another agent starts.

**Fallback hardening deployed and verified:** Kiro Prism source commit
`59d31ee0d9988f64e1ee4ca1699be1b7372613f0` includes the hardening introduced by
`476374a6ead9e9992ce03569b3defded5c70033e` and is deployed as immutable image
digest `sha256:3e1f36f63422caf91c453bf8dd679bc30f2cdbdfff742dddb0e09aafdbc57a3b`.

1. Cross-gateway fallback occurs only for safe, classified failures. Ambiguous
   post-dispatch outcomes, authentication failures, schema failures, malformed
   successes, and cancellation fail closed instead of silently replaying work.
2. Canonical responses retain the logical TypeSafe provider and add the serving
   gateway, ordered attempts, per-attempt outcome/model metadata, prior unknown
   outcomes, measured usage, and request identity needed for audit correlation.
3. One total deadline covers the complete provider chain. Remaining time is
   allocated deliberately, cancellation propagates, and invalid, unknown, or
   duplicate custom-order entries fail validation. Targeted tests cover cooldown,
   exhaustion, ambiguity retention, and all-provider failure.

Production health reports TypeSafe, Vercel AI Gateway, and OpenRouter ready in
the configured order. A live authenticated request against the deployed revision
returned Noul, Choice, and Score answers through TypeSafe with one successful
ordered attempt, serving-gateway provenance, request-id correlation, measured
usage, and bounded latency. Gateway diversity still does not imply independent
underlying model capacity, and a Jev decision never authorizes replaying a coding
worker or tool side effect.

Store credentials with existing protected configuration practices; do not
overwrite unrelated Router OpenRouter credentials. Never copy
the supplied literal keys into this document, repository files, task state,
agent prompts, shell arguments or diagnostic logs. Do not replace a working
production secret merely because another key was supplied.

### 6. Durable engineering contracts

Extend the existing Prism task/child persistence with versioned engineering
metadata. Expose only the narrow authenticated operations needed by the Codex
adapter if no supported interface currently exists. Such operations are new work,
not assumed public endpoints. Use repository/owner scoping and revision checks.

Required records:

- `EngineeringTask`: run/task/parent IDs, objective, acceptance criteria,
  dependencies, role, execution host, base revision, owned paths, policy version,
  current state, attempt limit/deadline, and artifact references.
- `EngineeringRoutingDecision`: task and assessment IDs, task type, complexity,
  risk, breadth, determinism, chosen role, eligible/rejected routes, selected
  route, ordered fallbacks, family constraints, strategy, review/verification
  policies, escalation reason and source (`jev` or deterministic fallback).
- `ExecutionBinding`: actual Codex thread/agent ID, exact model and provider,
  requested/effective effort and resolution source, role/preset policy version,
  host, worktree, branch, lease/fencing token, dispatch operation ID and attempt.
- `WorkerResult`: bounded summary, change list, base/result commit or tree hash,
  evidence references, test observations, unresolved issues and proposed next
  action. Worker `pass` is a claim pending verification, not acceptance.
- `VerificationResult`: runner identity, command and arguments with secrets
  redacted, cwd/host, source revision and dirty-tree digest where applicable,
  exit/signal/timeout, test counts, artifact digest/location and timestamps.
- `ReviewResult`: reviewer model/family, exact reviewed revision, findings,
  severity, disposition and remediation references.
- `EvidencePacket`: accepted result references, deterministic gate outcomes,
  review disagreements, residual risks, routing/usage summary and lead decision.

Proposed task progression:

```text
planned -> ready -> assigned -> running -> result_recorded
        -> verifying -> reviewing -> integrating -> accepted
```

Integration is conditional; for multi-worker changes, perform authoritative
verification/review again on the integrated revision. Failure transitions include
`retry_pending`, `needs_remediation`, `blocked`, `cancelling`, `cancelled`, and
`failed`. Record the state transition and reason atomically before dispatch.
Only runtime gates may set `accepted`. Preserve existing child attachment and
acknowledgement semantics instead of replacing them with this engineering view.

Use stable task/attempt IDs for dispatch reconciliation, compare-and-swap state
updates, and one active writer lease per writable scope. Persist assignment
before dispatch and result before notification. After a crash or ambiguous
response, query the known child and inspect its lease before redispatch. A
notification timeout, router restart, empty activity list or compaction is not
evidence that the child stopped. Recover existing children rather than replacing
healthy work. Store returned results once and acknowledge incorporation once.

### 7. Isolation, concurrency and strategies

Parallel read-only exploration may share the checkout. Parallel coding uses
separate worktrees/branches with recorded base revisions unless the host provides
an equivalent proven isolation boundary. Assign complete disjoint path ownership,
including tests, generated artifacts, lockfiles and config; account for case and
symlink aliases. Restrict each execution binding to its assigned checkout.

The integrator owns combining commits and shared Git mutations. Arena coding
candidates each receive their own worktree; only the selected candidate is
integrated. Reviewers inspect a fixed revision and do not concurrently edit it.
Retain failed work and artifacts until reconciled; clean up only task-owned
resources after results are safely recorded. Never remove a user's dirty worktree.

Scheduler admission is the minimum of ready independent work, currently available
shared runtime slots, explicit operator limits and measured provider/host capacity.
Do not hard-code six, 64 or 1,000 as a per-parent quota. Support 1,000-task graphs
and three nested levels through waves where the host supports them. Nested
coordinators share one run-level admission ledger so they do not oversubscribe
each other. A depth limit is a host capability to discover, not an API to invent.

Reconcile the Router-managed six-thread default without overwriting an explicit
user preference. The 256-entry HTTP observation cache in `subagent-turns.mjs`
must not become the durable task ledger or silently erase active run accounting.
Keep local shell/process concurrency conservative; run substantial tests, builds,
containers and browser automation remotely through existing project infrastructure.

Implement these graph strategies using the same state machine:

- `single`: one worker, required deterministic checks, applicable review.
- `swarm`: independent ownership slices, join, integration and final gates.
- `arena`: bounded competing solutions to an ambiguous brief, independent judge,
  recorded selection, integration of one chosen solution.
- `pipeline`: dependency-ordered exploration, implementation, verification,
  review, integration and synthesis.
- `interrogate`: independent family-diverse reviews, findings deduplication,
  evidence-based resolution and targeted remediation. Voting cannot dismiss a
  reproducible bug or overrule a failed deterministic check.

Verify useful concurrency from overlapping child start/finish intervals, not
configured slot counts or several assignments queued at the same instant.

### 8. Retry, fallback and health integration

**Mandatory DeepSeek V4.1 Flash capacity fallback, wherever selected.**
Every primary assignment, later fallback candidate, task override, preset,
test-author role, debugging role, review or arena entry that resolves to
DeepSeek V4.1 Flash must inherit the named policy
`deepseek-non-modal-fallback`. Attach it centrally by resolved model/route
identity, not by matching task prose. Do not require each workflow to remember
to declare it. Validate effective policy before dispatch and reject a DeepSeek
assignment with no eligible non-Modal recovery route.

The default capacity chain is **full GLM on a verified healthy non-Modal route
-> GPT-5.6 Sol -> Sonnet 5**. The JSON example uses the currently offered
`cloudflare-workers-ai/glm-5.3`; another verified non-Modal full GLM route can replace it
through policy. Resolve every route against current readiness/capabilities.
Kimi is not the default recovery route, and changing only the gateway while
still targeting the saturated Modal backend does not count as recovery.

On an explicit HTTP 429, including one without `Retry-After`, mark the attempted
DeepSeek capacity route temporarily unavailable and advance to the next eligible
candidate. Apply the same policy to a positively identified busy/capacity failure.
Default to no additional same-route retry at the orchestration layer; account
for any transport retries already spent. Respect `Retry-After` as a cooldown
for the failed route without making ready alternative work wait for it.
Use one total recovery deadline and record every actual serving route/effort.

This policy does not permit switching a response after output has started or
replaying a possibly completed tool action. If the capacity error occurs after
earlier tool turns, persist the checkpoint, reconcile/stop the previous writer,
and resume on the replacement. Preserve the task context, ownership, acceptance
criteria and review requirements. A review fallback that matches the author's
family is ineligible; choose another independent reviewer. If no compatible
fallback remains, record the exact exhaustion instead of repeatedly retrying
DeepSeek or silently escalating the coding work to Astra.

The full GLM/Sol/Sonnet choices and their effort levels remain editable, but
every effective DeepSeek assignment must retain at least one compatible
non-Modal fallback. This is an implementation requirement for the new workflow;
the current Router's generic 429 handling alone is not proof it is enforced.

There are two execution modes; keep their policy authority explicit:

1. **Dispatch-pinned worker mode, recommended initially:** policy selects a concrete
   offered Codex agent/model. Coordinator-level
   recovery starts a compatible replacement only after safely ending/reconciling
   the earlier attempt. Existing transport failover remains subject to its
   established guards and must report the model that actually ran.
2. **Adaptive worker mode, optional after proof:** a verified published
   `prism-auto` worker allows Prism to select a physical model. Supply supported
   child identity, record the actual physical route and enforce required
   capabilities/family constraints. Existing supervisor/worker classification
   does not yet prove engineering-role constraints are honored. Do not silently
   combine competing Router and Prism fallback authorities.

Dispatch pinning alone does not guarantee physical-model pinning: Router's
existing failover can change the serving model and does not enforce engineering
roles or reviewer-family independence. Add a scoped per-request policy to constrain
cross-model fallback when the task requires it, or reject/reassign a result whose
actual model lineage violates the role/family rule. Trace all serving models in a
multi-turn worker, not merely its initial or final model. Do not globally disable
working transport recovery for ordinary Router clients.

Normalize errors into `RATE_LIMIT`, `BUSY`, `TIMEOUT`, `AUTH`, `ENTITLEMENT`,
`BUDGET_EXHAUSTED`, `MODEL_UNAVAILABLE`, `PROTOCOL_ERROR`, `TOOL_ERROR`, and
`MODEL_QUALITY_FAILURE`, retaining dispatch/output state and retryability.

- Capacity: bounded backoff within one total attempt deadline, then compatible
  next route. For Kimi/DeepSeek Modal failures, prefer another healthy provider
  family rather than trying both routes against the same saturated fleet.
- Authentication/entitlement: report a distinct configuration failure; do not
  cycle every model sharing the bad credential. An explicitly configured
  independent provider fallback may proceed with the failure still visible.
- Timeouts: distinguish pre-dispatch, in-flight generation and unknown tool
  outcome. Never replay a potentially completed write without reconciliation.
- Protocol/schema failures: surface the faulty contract; do not misclassify them
  as capacity or evade them by random model rotation.
- Quality/test failure: preserve the failing invariant and evidence, remediate
  with a stronger/different family, and keep the same acceptance requirements.

Prism already defaults to three Modal capacity retry rounds with one-second base
and eight-second maximum delay. Coordinate Router, Prism and task retries under
a total deadline/attempt budget instead of multiplying these loops. Bound the
whole recovery path and record which layer consumed each attempt.

Never switch an in-progress response after relaying its first output byte.
Task-level replacement is a separate lifecycle action after the preceding
writer is known stopped. Record partial artifacts and unresolved side effects.

Reuse existing health/cooldown machinery, but explicitly prove cross-task circuit
behavior: repeated capacity failures open a temporary route/provider circuit;
unrelated tasks avoid it; one bounded half-open probe tests recovery; successful
recovery restores eligibility. Current per-request adaptive exclusions alone do
not establish this requirement. Persist only necessary content-free health data.

### 9. Astra context, synthesis and telemetry

Use two normal **lead phases**: initial judgment and final acceptance. A phase
can contain multiple model requests, so do not claim literally two inference
calls. Count actual requests and escalation phases separately.

Dispatch the ongoing execution to Sol with a minimal `ContextPacket`; use a
fresh child context or the supported minimal-history option rather than copying
all parent history. Each worker receives only its objective, invariants,
ownership, relevant paths/revisions, verified facts and required checks.

Proposed initial configurable limits: worker summary 8 KiB, synthesized lead
packet 24 KiB, selected critical excerpts 8 KiB within that packet. These are
design defaults to evaluate, not existing limits or token guarantees. Oversized
logs/diffs remain artifacts; summarize in a fast worker, retain hashes and source
references, and include unresolved failures even when compressing. Reject
silently truncated or unsupported success claims.

Jev can flag assessment dimensions but cannot synthesize prose. Gemini/GLM Flash
can summarize evidence; the controller carries immutable command outcomes and
review findings alongside that summary. Astra may retrieve specific artifacts
when judgment requires them. Host-owned child notifications may still reach the
parent; measure this behavior before claiming full context isolation.

Correlate `runId`, `taskId`, `attemptId`, role, Codex child ID, decision ID,
provider request ID and exact source revision to existing usage events. Continue
the supported `X-Prism-Client`, `X-Prism-Job-Type`, `X-Prism-Session`,
`X-Prism-Parent-Session`, `X-Prism-Agent-Id` and optional `X-Prism-Repo` attribution
without repurposing a response ID as an agent identity. New correlation fields
  must be schema-validated, content-free and backwards-compatible.

Expose measured/estimated/unknown usage distinctly, plus latency, retries,
physical fallback route, circuit state and verification outcomes. Astra's native
usage may bypass Prism; obtain it from a supported Codex/native accounting source
and join by run identity. Do not compute Astra's token share from worker-only
Prism data. Keep unavailable prices/costs unknown and avoid double-counting the
same request observed by both Router and Prism.

### 10. Deterministic acceptance and remote verification

Acceptance requires an immutable code revision/tree digest, applicable commands
executed by the runtime, passing required checks, resolved blocking review
findings, and required lead judgment. Tests skipped or not run are not passing.
Any relevant code change invalidates earlier verification/review evidence.

Select checks from repository instructions and change impact. Run type/compile,
unit/integration, applicable runtime/browser and static checks, then review and
acceptance. Reuse unchanged successful evidence. Do not rerun expensive checks
merely because another agent started. Execute heavy work through existing remote
CI/development environments; never start local Docker or browser suites as a
fallback. A remote runner's result includes logs, revision, exit status and
artifacts sufficient for the coordinator to verify the claim.

The first real proof is a small representative repository task: native Astra
delegates, Jev classifies, a different-model child edits an isolated checkout,
deterministic verification runs, another family reviews, Sol integrates, and
Astra receives one bounded evidence packet. Also prove native/routed encrypted
handoff compatibility and same-thread follow-up; a plain Responses request is
not enough.

### 11. Implementation boundaries and delivery sequence

Proposed Router modules under `src/engineering/`:

- `contracts.mjs`, `policy.mjs`: versioned engineering schemas, editable presets
  and role/model/effort resolution referencing the existing registry.
- `prism-decisions.mjs`: authenticated client for the existing Prism contract;
  no direct TypeSafe key and no duplicate vendor protocol implementation.
- `codex-executor.mjs`: capability discovery and verified host lifecycle adapter.
- `scheduler.mjs`: dependencies, admission, idempotent dispatch/recovery and leases.
- `worktrees.mjs`: checkout provenance, ownership, integration and cleanup.
- `evidence.mjs`, `verification.mjs`: bounded packets and revision-bound gates.
- `telemetry.mjs`: correlation to existing Router/Prism/native usage sources.

Keep these modules distinct from HTTP forwarding. Prefer reusing an existing
equivalent discovered during implementation over creating a named file merely
to satisfy this list. Add a Codex workflow skill/agent binding through the
existing supported publication mechanism; generated role files and managed
settings need idempotent install, refresh, doctor and uninstall behavior.

Prism changes, when needed, are limited to versioned engineering assessment
metadata, a scoped persistence/policy bridge over existing task/child classes,
telemetry correlation and proven cross-task health behavior. Scoped effort
precedence belongs in the Codex execution binding and Router request handling;
Prism continues to translate supported provider controls. Reuse the now-existing
Vercel/OpenRouter Jev fallback; its error policy,
deadline and gateway provenance need the specific hardening described above.
Do not migrate
working coding-provider connections or expose admin credentials to worker agents.

Implement and verify in this order:

1. **Lifecycle spike:** prove native Astra -> exact offered routed child -> native
   result, routed Sol -> different-model generated agent precedence, child
   resume/cancel, worktree execution and safe result attachment.
   Record which adapter is actually supported by the installed client.
2. **Policy/decision integration:** reuse Prism's multi-provider Jev lane, validate
   one editable role/model/effort registry, resolve exact identities and effort
   precedence, implement conservative classifier-outage behavior.
3. **Single task path:** persist assignment/result, run a worker, collect authentic
   verification/review evidence and return a bounded packet to Astra.
4. **Durable recovery:** exercise crashes between assignment, dispatch, result,
   notification and acknowledgement; prevent duplicate writers and side effects.
5. **Parallel strategies:** add isolated swarm/pipeline, arena selection and
   family-diverse interrogation with one integration owner.
6. **Failure/health:** enforce combined retry deadlines, provider-aware fallback,
   circuit recovery and quality-driven escalation.
7. **Operations:** expose routing/usage/gate state; validate privacy, cleanup,
   configuration preservation, supported OS behavior and rollback.
8. **Jev fallback hardening:** reuse the existing three-gateway integration;
   verify its error-class policy, total deadline, gateway attribution and prior
   ambiguous outcomes. Reuse the operator's live/test evidence when matched to
   the unchanged implementation, rather than repeating key setup.

Default the new workflow off until explicitly selected. Disabling it restores
ordinary Codex behavior without deleting ordinary routed models, user agents,
ChatGPT authentication, provider keys or retained task evidence. Do not restart
or terminate the user's Codex application as a documentation/setup side effect.

### 11.1 Implemented Codex control and execution surfaces

The integration is a persistent **on/off mode**, not an automatic replacement
for every Codex task. A clean installation reports revision `0` with engineering
mode off. When the operator turns it on, new engineering runs automatically use
the active role/model/effort policy; ordinary Codex turns and already-running
attempts keep their existing behavior and immutable bindings. Turning it off
blocks new engineering assignments and does not delete routes, keys, user agents,
policy history, task state, or evidence.

The canonical CLI is:

```text
bin/model-router codex engineering status
bin/model-router codex engineering on --revision N
bin/model-router codex engineering off --revision N
bin/model-router codex engineering policy
bin/model-router codex engineering policy replace --file POLICY.json --revision N
bin/model-router codex engineering preview ROLE [--model SLUG] [--effort LEVEL] [--high-risk]
bin/model-router codex engineering usage
```

`policy` emits the complete sanitized, editable policy. The operator can change
a role's ordered candidates, provider route, optional models, presets, or any
supported reasoning effort, then atomically replace the policy with the current
revision. Validation rejects unknown routes, unsupported efforts, duplicate
candidates, and any DeepSeek V4.1 Flash placement that lacks a later healthy
non-Modal recovery route. Running attempts retain their assignment snapshot.

The Control Center exposes the same edits directly under **Settings →
Engineering orchestration → Role routing**. Each role has model and effort
selectors, ordered primary/fallback controls, optional-specialist controls, and
a reset-to-preset action. The native lead has its own model and effort editor.
Every save is compare-and-swap guarded by the displayed policy revision and
affects only new assignments. An effort of `default` means the role sends no
per-assignment override; the selected model's currently configured default is
used. The UI shows that resolved default when the catalog publishes it. Choosing
`low`, `medium`, `high`, `xhigh`, `max`, or `ultra` pins the role explicitly and
is accepted only when that exact model advertises the level.

The authenticated Router surface is `GET /v1/engineering` and
`PATCH /v1/engineering` with exactly `{ "expectedRevision": N, "enabled":
BOOLEAN }`. It returns the same allowlisted snapshot published at
`catalog.engineering`. The Electron Control Center and native macOS tray consume
that snapshot. The Electron app issues revision-guarded toggles and role/lead
edits with optimistic error reporting; the tray shows the lead and highest
priority role routes. An
older Router, degraded policy, stale snapshot, or unknown schema disables the UI
control instead of being displayed as a false off state.

Each scheduled attempt receives an immutable `ExecutionBinding`. Codex app-server
starts the worker in the assigned worktree with the exact model, provider and
effort, while a thread-scoped provider configuration carries only the opaque
binding ID to Router. Router resolves that ID from owner-only durable scheduler
state, verifies the current fenced attempt, and applies the bound effort without
trusting a caller-provided effort header. This lets two concurrent tasks use the
same model with different effort levels without changing a global model setting.

The repository-managed `codex-engineering-orchestrator` skill is installed and
refreshed through the existing skill pack. Doctor treats the default-off state as
healthy, and when enabled verifies policy, exact route/effort support, DeepSeek
recovery, private state, managed skill ownership and Codex app-server support.
Support bundles include sanitized mode metadata only. Disable, refresh and
uninstall preserve provider selection, credentials, user agents and skills, and
retained engineering state/evidence; uninstall removes only the managed skill.

### 11.2 Verification record for this implementation

The repository evidence for the implementation is deliberately separate from
provider availability. Focused engineering, routing and resilience validation
passed 199 of 199 checks before release. The corrected Windows portability
cases then passed their focused 20-check lane, and exact-code commit
`ebabbd85eee5c717eb6acdfb17738e660d3c1766` passed the full Ubuntu, macOS and
Windows test jobs, both Electron packages, the unified macOS application,
formula consistency, and a macOS Homebrew source install. The separate manual
Ubuntu Homebrew source install remained inside its single opaque build step for
76 minutes and was cancelled after all functional Linux coverage had passed; it
is not an application, router, provider or orchestration failure. Static checks,
owner-only state tests, secret-pattern scans, route/effort isolation,
process-tree cleanup, install/refresh/disable/uninstall preservation, and doctor
all pass. The installed Codex plane reports engineering revision `0`, preset
`balanced`, `enabled: false`, `healthy: true`, 117 routed models and 31 routed
agents. This is the intended clean-install state: the workflow is available but
does not replace ordinary Codex behavior until explicitly enabled.

The bounded live pass on 2026-09-22 certified the direct Google Gemini 3.8
Flash route for ordinary response, streaming, tool calling, stateless
tool-result replay and compaction. After deploying the pinned Prism image,
Sonnet 5, Opus 5, GPT-5.6 Sol, GPT-5.6 Luna and high-effort Kimi K3 completed
bounded requests. After replacing the stale protected Cloudflare credential,
both full GLM 5.3 and GLM 5.3 Flash completed bounded live requests through
Workers AI. DeepSeek V4.1 Flash reached its configured Modal route but returned
HTTP 429 after bounded retries. It therefore remains capacity-excluded until a
future live primary request succeeds; production fault injection proves that a
safe pre-output 429 advances through eligible full GLM, Sol and Sonnet routes,
with a new immutable attempt binding and no Kimi insertion. Catalog presence
alone is never treated as a live model proof.

### 12. Required test and rollout evidence

Extend existing relevant suites rather than duplicating their fixtures:

- Router: `test/codex-agent-catalog.test.mjs`,
  `test/subagent-model-inherit.test.mjs`, `test/subagent-routing.test.mjs`,
  `test/subagent-turns.test.mjs`, `test/subagent-completion.test.mjs`,
  `test/model-failover.test.mjs`, `test/model-failover-router.test.mjs`,
  `test/subagent-effort.test.mjs`, `test/usage-events.test.mjs`, and native/routed replay cases in
  `test/routing.test.mjs`.
- Prism: `tests/test_jev_client.py`, `tests/test_typesafe_upstream.py`,
  `tests/test_jev_multi_fallback.py`,
  `tests/test_adaptive_model_registry.py`, `tests/test_adaptive_routing.py`,
  `tests/test_adaptive_runtime_integration.py`,
  `tests/test_adaptive_reroute_and_exclusions.py`,
  `tests/test_adaptive_lifecycle.py`, `tests/test_durable_task_checkpoint.py`.
- New engineering tests: unknown/disabled/unverified route rejection; actual
  offered-agent resolution; Jev contract failures; low-confidence policy;
  DAG/lease admission; worktree escape/conflict handling; restart reconciliation;
  duplicate notification; cancellation; combined retry deadline; Modal capacity
  fallback; provider-family diversity; integrated-revision verification; failure
  cannot become acceptance; bounded evidence and accurate usage attribution.
- Model/effort controls: replace a role's model using configuration only; change
  effort without changing its model; run the same model concurrently with two
  distinct role efforts; honor one-task overrides; clear back to defaults;
  reject unsupported/unknown effort; preserve each fallback's own effort; keep
  running attempts on their original snapshot; refresh stale generated bindings;
  change the lead explicitly; preserve non-engineering Router behavior.
- Jev multi-provider hardening: ambiguous first gateway followed by success or
  definite failure; auth/schema error policy; total deadline and cancellation;
  unknown/duplicate order entries; prior-outcome and gateway provenance retention.

Engineering rollout checklist: pending unless explicitly marked with the
operator-reported evidence below; vendor endpoint success alone does not prove
the complete Codex workflow.

**2026-09-22 live rollout record:** direct Gemini completed a real read-only
repository task through Google's API route. After Kiro Prism was replaced with
the pinned `59d31ee0` image, routed Sonnet 5, Opus 5, GPT-5.6 Sol, GPT-5.6 Luna,
and high-effort Kimi K3 completed bounded live requests. After the protected
Cloudflare token was refreshed, full GLM 5.3 and GLM 5.3 Flash also completed
bounded live repository tasks. The deployed decision lane completed one
authenticated Noul/Choice/Score request with provenance and usage. DeepSeek
V4.1 Flash reached Modal but returned HTTP 429; targeted production-adapter
tests prove persisted, bounded GLM/Sol/Sonnet recovery while the live primary
route remains capacity-excluded.
Catalog publication alone is not counted as a pass.

- [x] Native Astra remains lead while routed Gemini, Sonnet, Opus, Sol, and Luna
  workers complete bounded real tool tasks.
- [x] Routed deputy -> differently typed worker retains the selected child model
  despite default parent-model injection, or that relay conflict is repaired.
- [x] Existing protected Router credentials authenticate a valid live Jev
  decision request against deployed Prism commit `59d31ee0`.
- [x] The original verification recorded successful probability probes through
  TypeSafe, Vercel and OpenRouter plus 145 passing checks. The follow-up matched
  the deployed revision and image digest and independently exercised the shared
  authenticated Prism decision endpoint without reading credential values.
- [x] Noul/Choice/Score, fallback ambiguity policy, gateway provenance, and the
  total deadline have live or targeted test evidence on the deployed revision.
- [x] Each selected route passes a bounded tool/handoff probe; unavailable routes
  are explicitly excluded rather than declared healthy from catalog presence.
- [x] Full GLM 5.3's intended Cloudflare route is resolved and proven through
  a bounded live repository tool task.
- [x] Pinned and optional adaptive modes preserve their documented boundaries;
  adaptive candidates require explicit mode and exact-route enablement.
- [x] Two useful child execution intervals overlap on isolated work surfaces;
  graph-executor tests record the actual intersecting start/finish intervals.
- [x] Fault injection proves bounded Modal fallback and cross-task recovery.
- [x] Crash/resume and transcript compaction retain child assignments and exact
  evidence in owner-only durable state; controller reconstruction, idempotent
  notification and turn-excluding resume paths have targeted regression tests.
- [x] A failed required test, stale revision or blocking review prevents acceptance.
- [x] A bounded final packet reaches the Astra judgment adapter in controller
  tests, with oversized evidence retained through raw artifact references.
- [x] Lead invocation, token, and context fields are durably measured, estimated,
  or explicitly unknown; routine zero-call runs record an invocation count of 0.
- [x] Models, provider routes and effort levels can be swapped through policy
  configuration without code edits, cross-task leakage or unsupported values.
- [x] Existing clients, provider selection, credentials and user settings survive
  install/refresh/disable/uninstall unchanged outside the owned integration.

For implementation, run focused checks first and the repository-required
`npm run check` plus appropriate broader tests remotely when substantial. Run
Prism suites through its existing remote validation environment. Documentation
editing alone does not require paid inference or a full runtime test matrix.

### 13. External protocol references checked during research

- [TypeSafe introduction](https://docs.typesafe.ai/introduction) and
  [quick start](https://docs.typesafe.ai/introduction/quickstart): typed decisions
  and native System One wire format.
- [Vercel TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
  and [evaluation API](https://vercel.com/docs/ai-gateway/modalities/evaluation):
  distinct compatible/evaluation endpoints and field names.
- [OpenRouter Jev model API](https://openrouter.ai/typesafe/jev-1.13/api) and
  [official Jev decision example](https://openrouter.ai/labs/jev/compile): model
  identity and published typed-Decisions SDK use.
- [Codex subagents](https://developers.openai.com/codex/multi-agent): general
  client capability context. The installed tool schema and repository-native
  handoff tests remain authoritative for this deployment.

The remaining original sections state the desired behavior. Read conceptual
names and proposed workflows through the concrete integration rules above.

---

## Objective

Build the production orchestration layer that lets **GPT-6 Astra act as the lead engineer / principal orchestrator inside Codex without using Astra as the default coding model**.

Astra is extremely capable but consumes too many tokens to use for routine implementation work.

The desired architecture is:

```text
User
  │
  ▼
GPT-6 ASTRA
Lead Engineer / Orchestrator
  │
  ├── understands intent
  ├── makes architecture decisions
  ├── decomposes work
  ├── delegates
  ├── resolves disagreement
  └── makes final engineering judgment
  │
  ▼
PRISM / JEV
Task Intelligence + Routing Policy
  │
  ├── classify task
  ├── determine risk
  ├── determine complexity
  ├── select worker role
  ├── select model pool
  ├── choose parallel vs serial
  ├── determine verification requirements
  └── determine escalation policy
  │
  ▼
CODEX ROUTER
Existing model/provider execution layer
  │
  ├───────────────┬─────────────────┬─────────────────┐
  ▼               ▼                 ▼                 ▼
Gemini 3.8     GLM 5.3 / Flash    Kimi K3      DeepSeek V4.1 Flash
Flash            Cloudflare        Modal               Modal
  │               │                 │                   │
  └───────────────┴─────────────────┴───────────────────┘
                          │
                additional workers
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
       GPT-5.6 family          Opus 5 / Sonnet 5
                               via Kiro Prism API
                          │
                          ▼
                 deterministic verification
                          │
                          ▼
                   independent review
                          │
                          ▼
                     ASTRA GATE
                          │
                  accept / reject /
                 retry / escalate
```

The goal is **not** to build another model gateway.

Codex Router already provides multi-model access.

Prism/Kiro Prism already provides several model/provider connections.

Prism already implements Jev typed decisions and adaptive task classification.
The engineering role policy and Codex lifecycle integration extend that work.

Reuse those systems.

The missing layer is the engineering orchestration policy connecting them together.

---

# CORE DESIGN PRINCIPLE

## Astra is the lead engineer, not the implementation worker.

Astra should primarily perform:

1. intent interpretation;
2. architecture judgment;
3. task decomposition;
4. delegation decisions;
5. adjudication between conflicting model recommendations;
6. high-risk escalation;
7. final review of synthesized evidence;
8. deciding whether work is truly complete.

Astra should normally **NOT** perform:

* repository-wide searches;
* bulk file reads;
* mechanical edits;
* routine feature implementation;
* straightforward bug fixes;
* test generation;
* test execution monitoring;
* lint cleanup;
* repetitive refactors;
* documentation sweeps;
* raw log analysis when another model can summarize it;
* reading enormous diffs line-by-line when a review worker can produce a focused evidence packet.

The happy path should therefore be:

```text
Astra receives request
        ↓
Astra + Jev establish engineering plan
        ↓
Astra delegates
        ↓
Workers execute
        ↓
Workers verify
        ↓
Independent reviewers inspect
        ↓
Results are compressed into an evidence packet
        ↓
Astra sees the evidence packet
        ↓
Astra approves, rejects, or requests targeted remediation
```

Do not repeatedly re-invoke Astra throughout routine worker execution.

---

# IMPORTANT: FIRST AUDIT THE EXISTING SYSTEM

Before changing anything, inspect the repository and current runtime.

Locate and understand:

* Codex Router integration
* Prism
* Jev
* Kiro Prism model APIs
* current subagent spawning
* current model-selection code
* provider registry
* model aliases/slugs
* task routing
* retry logic
* model fallback behavior
* concurrency controls
* worktree handling
* token/accounting instrumentation
* existing skills
* current agent definitions
* existing orchestration abstractions
* existing tests
* existing configuration formats

Do not invent duplicate abstractions when a suitable seam already exists.

Do not rebuild Codex Router.

Do not rebuild Kiro Prism.

Do not create a second provider registry if one already exists.

Extend the existing architecture.

Actual repository behavior is authoritative over this prompt when naming files, APIs, and model slugs.

If names differ, adapt the implementation to the actual codebase.

---

# TARGET MODEL ROLES

The system must support role-based model selection rather than hard-wiring individual models throughout the code.

Every model assignment below is an editable starting preset. Each candidate
carries its own reasoning-effort setting, including fallback candidates. The
operator can replace models and efforts independently through the central policy;
the detailed model/effort controls in section 4.1 define validation, precedence,
concurrent-task isolation and when configuration changes take effect.

Create one authoritative role registry.

Conceptually:

```yaml
lead_engineer:
  primary: gpt-6-astra
  fallback:
    - gpt-5.6-sol

architecture:
  candidates:
    - gpt-6-astra
    - gpt-5.6-sol
    - claude-opus-5

fast_general_worker:
  candidates:
    - gemini-3.8-flash
    - glm-5.3-flash
    - gpt-5.6-fast-equivalent

general_coder:
  candidates:
    - gemini-3.8-flash
    - claude-sonnet-5
    - gpt-5.6-worker-equivalent

complex_coder:
  candidates:
    - claude-sonnet-5
    - gpt-5.6-sol
    - glm-5.3
  optional_candidates:
    - kimi-k3

debugger:
  candidates:
    - deepseek-v4.1-flash
    - glm-5.3
    - gpt-5.6-sol
    - claude-sonnet-5
  capacity_failure_policy: deepseek-non-modal-fallback

mechanical_worker:
  candidates:
    - glm-5.3-flash
    - gemini-3.8-flash

repo_explorer:
  candidates:
    - gemini-3.8-flash
    - glm-5.3-flash

test_author:
  candidates:
    - gemini-3.8-flash
    - deepseek-v4.1-flash
    - glm-5.3
  deepseek_capacity_failure_policy: deepseek-non-modal-fallback

reviewer:
  candidates:
    - gpt-5.6-sol
    - claude-opus-5
    - glm-5.3
  optional_candidates:
    - kimi-k3

integrator:
  candidates:
    - gpt-5.6-sol
    - claude-sonnet-5

prose_docs:
  candidates:
    - gemini-3.8-flash
    - claude-sonnet-5
```

This is a policy example, not permission to invent model slugs.

Detect the real model identifiers that Codex Router/Kiro Prism currently expose.

---

# DEFAULT MODEL STRATEGY

## Gemini 3.8 Flash

Treat Gemini 3.8 Flash as the default high-speed general worker when appropriate.

Use it heavily for:

* repository exploration;
* targeted code reading;
* simple and moderate implementations;
* test generation;
* test repair;
* dependency tracing;
* mechanical refactors;
* documentation;
* data gathering;
* first-pass code review;
* summarizing worker results;
* converting huge terminal output into concise evidence.

Its speed should make it the default for many tasks unless Jev determines the task requires stronger reasoning.

---

# GLM 5.3 / GLM 5.3 FLASH

Existing provider:

```text
Cloudflare Workers AI
```

Use GLM 5.3 Flash for:

* cheap mechanical work;
* repo sweeps;
* repetitive edits;
* file classification;
* straightforward tests;
* search and analysis;
* first-pass review.

Use full GLM 5.3 for:

* debugging;
* stronger implementation;
* alternate code-generation perspective;
* adversarial review;
* fallback when another coding provider is busy.

---

# KIMI K3

Existing provider path:

```text
Kiro Prism
    ↓
Modal
```

Keep Kimi K3 available, but use it sparingly. Sonnet 5 and GPT-5.6 handle
substantial implementation by default; Gemini Flash handles routine work.
Kimi is appropriate when the operator explicitly selects it, a bounded task
benefits from a different implementation perspective, or an enabled later
fallback is needed after the preferred routes are unavailable or unsuitable.

Do not assign Kimi simply because a task is large, multi-file or code-heavy.
Default role presets exclude it from routine implementation and review chains.
Enabling it for one task/run must not increase its share across unrelated work.

However Modal occasionally returns:

```text
429
busy
capacity/load errors
```

Therefore Kimi MUST NOT be a blocking dependency.

Reuse existing bounded transport retry and add the missing task-level fallback,
with one combined deadline and safe reconciliation of any previous writer.

Example behavior:

```text
Kimi requested
      ↓
request succeeds
      ↓
continue

OR

429/busy
      ↓
small bounded retry if appropriate
      ↓
still busy
      ↓
immediately route to next compatible worker
```

Do not sit in repeated retry loops waiting on Modal capacity.

---

# DEEPSEEK V4.1 FLASH

Existing provider path:

```text
Kiro Prism
    ↓
Modal
```

Prioritize it for:

* debugging;
* root-cause analysis;
* algorithms;
* test construction;
* reproduction;
* code reasoning;
* independent code review.

Every use inherits `deepseek-non-modal-fallback` from section 8, including a
task override or use as another model's fallback. On 429/busy/capacity failure,
advance to healthy non-Modal full GLM, then Sol, then Sonnet as eligible.
Each replacement uses its own configured effort. Kimi is not the default
fallback, and the task must never wait indefinitely for Modal capacity.

---

# CLAUDE OPUS 5

Existing provider:

```text
Kiro Prism models API
```

Use Opus selectively because it is a premium reasoning resource.

Best roles:

* independent architecture critic;
* adversarial reviewer;
* difficult design fork;
* complicated concurrency;
* hard-to-reproduce correctness issue;
* high-risk final review.

It should not routinely implement mundane features.

---

# CLAUDE SONNET 5

Existing provider:

```text
Kiro Prism models API
```

Use Sonnet as a strong balanced engineering worker.

Good roles:

* feature implementation;
* substantial refactoring;
* frontend work;
* integration;
* code review;
* fallback for Kimi or DeepSeek capacity failure.

---

# GPT-5.6 FAMILY

Keep the GPT-5.6 models available throughout the stack.

GPT-5.6 Sol should act as the primary **deputy lead / senior engineer** below Astra.

It is particularly useful for:

* integration;
* difficult coding;
* architecture;
* security-sensitive work;
* concurrency;
* cross-worker synthesis;
* independent review;
* situations where Astra should not spend more tokens.

If other GPT-5.6 tiers are available, map them according to cost/speed/capability rather than hard-coded names.

---

# ASTRA TOKEN CONTROL

This is a critical requirement.

We are intentionally choosing Astra as lead despite high token consumption.

Implement mechanisms that aggressively prevent unnecessary Astra context growth.

## Rule 1: File pointers over file contents

Workers should return:

```text
file path
line/range
commit
artifact path
test report path
short summary
```

Do not inline giant files into Astra's context.

---

## Rule 2: Evidence packets

Create a standard result contract.

Conceptually:

```ts
type WorkerResult = {
  taskId: string;
  status: "pass" | "issues" | "blocked";

  summary: string;

  filesChanged: Array<{
    path: string;
    purpose: string;
  }>;

  evidence: Array<{
    type:
      | "test"
      | "runtime"
      | "diff"
      | "benchmark"
      | "screenshot"
      | "static-analysis"
      | "review";
    location?: string;
    summary: string;
  }>;

  commandsRun: string[];

  tests: {
    passed: string[];
    failed: string[];
  };

  risks: string[];

  unresolved: string[];

  recommendedNextAction?: string;
};
```

The exact structure should match repository conventions.

The important point is that Astra receives structured evidence rather than raw transcripts.

---

## Rule 3: Compress terminal output

Never send enormous:

```text
npm test
pytest
Playwright
build
lint
git diff
compiler
runtime
```

outputs directly to Astra unless the raw lines are specifically relevant.

A fast worker should summarize them and retain the complete log as an artifact.

---

## Rule 4: Only escalate relevant diffs

Astra should normally receive:

```text
files changed
behavior changed
risk
important hunks
test evidence
review disagreements
```

instead of a 20,000-line raw diff.

Astra can request specific files or hunks when needed.

---

## Rule 5: Astra invocation discipline

Target a normal execution lifecycle resembling:

```text
Astra lead phase #1
Understand + architect + delegate

        ↓

workers execute without Astra

        ↓

verification/review without Astra

        ↓

Astra lead phase #2
Final engineering judgment
```

Each phase may require multiple actual model calls; count them separately.
Additional Astra phases are allowed when:

* architecture changes materially;
* workers disagree on a critical point;
* repeated worker failures occur;
* a security/correctness risk appears;
* requirements prove internally inconsistent;
* an escalation threshold is reached.

Do not invoke Astra after every child task.

---

# JEV TASK INTELLIGENCE CONTRACT

Extend the existing Prism Jev assessment and deterministic engineering policy so
every engineering task can produce a structured routing decision. Jev supplies
typed assessments; application code produces the combined contract below.

Conceptually:

```ts
type EngineeringTaskDecision = {
  taskType:
    | "investigation"
    | "mechanical-edit"
    | "feature"
    | "bug-fix"
    | "refactor"
    | "test"
    | "performance"
    | "architecture"
    | "security"
    | "ui"
    | "documentation"
    | "review"
    | "release";

  complexity: "low" | "medium" | "high" | "extreme";

  risk: "low" | "medium" | "high" | "critical";

  breadth: "single-file" | "localized" | "cross-cutting" | "repo-wide";

  determinism: "high" | "medium" | "low";

  preferredRole: string;

  candidateModels: string[];

  fallbackModels: string[];

  parallelism: number;

  strategy:
    | "single"
    | "swarm"
    | "arena"
    | "pipeline"
    | "interrogate";

  reviewPolicy: string;

  verificationPolicy: string;

  astraRequired:
    | "initial-only"
    | "final-only"
    | "initial-and-final"
    | "continuous";
};
```

Again, adapt this to the codebase rather than creating redundant types.

---

# EXECUTION LEVELS

Implement an escalation ladder.

## LEVEL 0 — deterministic tools

Use tools before consuming another expensive model when possible.

Examples:

```text
grep
ripgrep
AST queries
compiler
tests
lint
git
Playwright
benchmarks
runtime instrumentation
static analysis
```

---

## LEVEL 1 — fast workers

Default:

```text
Gemini 3.8 Flash
GLM 5.3 Flash
```

Use for most low/medium-complexity work.

---

## LEVEL 2 — strong coding workers

Use:

```text
Sonnet 5
GPT-5.6 worker tier
DeepSeek V4.1 Flash (debugging)
GLM 5.3
Kimi K3 (optional specialist / enabled later fallback)
```

when Level 1 is inadequate or Jev identifies higher complexity.

---

## LEVEL 3 — senior reviewers

Use:

```text
GPT-5.6 Sol
Opus 5
```

for difficult review and high-risk engineering.

---

## LEVEL 4 — Astra adjudication

Astra resolves:

* major architectural forks;
* contradictory reviewer conclusions;
* repeated failed implementation attempts;
* critical correctness concerns;
* final acceptance for major work.

Do not jump directly to Level 4 for routine implementation.

---

# PSTACK-STYLE ENGINEERING WORKFLOWS

Do not import Cursor-specific APIs.

Adapt the useful concepts.

## 1. SINGLE

One worker handles a clearly bounded task.

Example:

```text
Jev
 ↓
Gemini Flash
 ↓
verify
 ↓
done
```

---

## 2. SWARM

Use when work naturally partitions.

Example:

```text
repo-wide migration

worker 1 → package A
worker 2 → package B
worker 3 → package C
worker 4 → tests
```

Every worker must own a separate slice or isolated writable surface.

---

## 3. ARENA

Use when the solution is genuinely ambiguous.

Run multiple models against the same brief.

Example:

```text
same architecture problem
        │
 ┌──────┼──────┐
 ▼      ▼      ▼
GLM    Sol    Sonnet
 │      │      │
 └──────┼──────┘
        ▼
 independent judge
        ▼
 Astra adjudication if needed
```

Do not use Arena for obvious mechanical tasks.

---

## 4. INTERROGATE

For high-risk changes, use multiple model families to independently attack the finished implementation.

Example:

```text
implementation
      ↓
reviewer: Sol
reviewer: Opus
reviewer: GLM
      ↓
dedupe findings
      ↓
consensus map
      ↓
fix real issues
```

Reviewer diversity matters more than reviewer count.

Prefer different model families.

---

# WORKER ISOLATION

Parallel coding workers must not fight over the same working tree.

Use the existing Codex worktree/isolation mechanism if present.

Otherwise use Git worktrees/branches.

Conceptually:

```text
task-123/
    worker-a/
    worker-b/
    worker-c/
```

Workers should not concurrently modify the same branch unless the underlying execution system explicitly guarantees safe isolation.

The integration role owns combining work.

---

# INTEGRATION ROLE

Do not make Astra manually integrate routine diffs.

Use:

```text
GPT-5.6 Sol
or
Sonnet 5
```

as an integration engineer.

The integrator can:

* read worker outputs;
* cherry-pick selected commits;
* resolve straightforward conflicts;
* normalize implementations;
* run tests;
* produce final diff evidence.

Astra then reviews the integration result rather than performing the integration itself.

---

# RETRY AND PROVIDER FALLBACKS

Implement provider-aware health behavior.

Model execution failures must be categorized.

Examples:

```text
RATE_LIMIT
BUSY
TIMEOUT
AUTH
MODEL_UNAVAILABLE
PROTOCOL_ERROR
TOOL_ERROR
MODEL_FAILURE
```

### Capacity failure

For:

```text
429
busy
capacity
```

use:

```text
bounded retry
      ↓
fallback model
```

Do not burn minutes repeatedly hammering one overloaded provider.

### Auth/configuration failure

Do not rotate randomly through every model.

Surface configuration failure distinctly.

### Model-quality failure

If the model completed but produced incorrect work, escalation should usually move to a stronger/different model family.

---

# CIRCUIT BREAKER

Reuse existing provider/model health state and implement any missing cross-task
circuit behavior, with explicit cooldown and recovery proof.

For example:

```text
Kimi K3 @ Modal
429
429
429

→ temporarily degraded

Jev avoids route for subsequent tasks

→ periodic health probe

→ restore when healthy
```

Do not permanently disable routes because of temporary capacity.

Reuse existing health infrastructure if available.

---

# MODEL DIVERSITY

Do not confuse multiple agents with independent thinking when they all use the same model family.

For high-risk reviews, prefer diversity such as:

```text
GPT
Claude
GLM/Kimi/DeepSeek
```

rather than:

```text
GPT
GPT
GPT
```

For simple parallel implementation, same-model fanout is fine.

---

# VERIFICATION MUST BE DETERMINISTIC WHERE POSSIBLE

Models do not decide whether tests passed.

The runtime does.

Required ordering:

```text
implementation
      ↓
compile/typecheck
      ↓
unit/integration tests
      ↓
runtime/Playwright verification where applicable
      ↓
static checks
      ↓
review
      ↓
acceptance gate
```

No worker may claim success purely because:

```text
"the code looks correct"
```

---

# FAILURE-DRIVEN ESCALATION

Example:

```text
Gemini Flash attempt
       ↓ fails verification

Sonnet attempt
       ↓ fails same invariant

DeepSeek root-cause analysis (429: non-Modal GLM -> Sol -> Sonnet)
       ↓ identifies deeper issue

Sol reviews diagnosis
       ↓

Astra only enters if
architecture or requirements
need re-evaluation
```

Astra should not automatically become the next coding model after one worker failure.

---

# ASTRA SHOULD CHALLENGE THE PLAN

Astra's value is engineering judgment.

Before execution it should explicitly evaluate:

```text
Are we solving the correct problem?

Is this the smallest correct change?

Is the requested architecture actually necessary?

Can we delete instead of add?

Are we preserving a broken assumption?

What could break?

What evidence will prove completion?

What should NOT be changed?
```

Then delegate.

---

# CONTEXT PACKAGING

Build a `ContextPacket` abstraction or equivalent.

Workers should receive only the information necessary for their slice.

Example:

```ts
type ContextPacket = {
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];

  relevantFiles: string[];

  knownFacts: string[];

  priorDecisions: string[];

  taskSpecificEvidence: string[];

  prohibitedChanges: string[];

  verification: string[];
};
```

Avoid copying the whole conversation/repository context into every worker.

---

# RESULT SYNTHESIS

Add a low-cost synthesis stage before Astra sees worker results.

Default candidate:

```text
Gemini 3.8 Flash
```

or:

```text
GLM 5.3 Flash
```

It should turn:

```text
10 worker responses
6 test logs
4 diffs
3 review reports
```

into something like:

```text
STATUS: PASS

Implemented:
- A
- B
- C

Changed:
- path/file1.ts
- path/file2.ts

Verification:
- unit: 142 passed
- integration: 37 passed
- Playwright: 18 passed

Independent review:
- Sol: PASS
- Opus: 1 issue
- GLM: same issue

Issue resolved:
- ...

Remaining risks:
- ...

Decision needed:
- none
```

Astra sees this packet.

Raw artifacts remain available by file pointer if Astra wants to inspect them.

---

# ROUTING EXAMPLES

## Simple mechanical change

```text
Astra/Jev classify
        ↓
GLM Flash
        ↓
tests
        ↓
complete
```

Do not send back through Astra unless policy requires final acknowledgment.

---

## Moderate feature

```text
Astra defines architecture
        ↓
Jev
        ↓
Gemini Flash or Sonnet
        ↓
test worker
        ↓
Sol review
        ↓
summary
        ↓
Astra final gate
```

---

## Difficult bug

```text
Astra sets investigation objective
        ↓
DeepSeek reproduction/root cause (429: non-Modal GLM -> Sol -> Sonnet)
        ↓
Sonnet/GPT-5.6 implements
        ↓
Gemini writes/runs additional regression tests
        ↓
Sol + GLM review
        ↓
Astra receives evidence
```

---

## Major architectural work

```text
Astra
  ↓
architecture brief

Arena:
Sol
Opus
GLM
  ↓
compare

Astra selects architecture
  ↓
Astra/Sol decomposes work; Jev assesses the proposed tasks
  ↓
worker fleet
  ↓
integration
  ↓
interrogate
  ↓
Astra final approval
```

---

# COST / TOKEN POLICY

Build configurable policy rather than hard-coded assumptions.

Track where possible:

```text
model
provider
task
latency
input tokens
output tokens
cost
success/failure
retry count
verification outcome
```

The system should eventually allow Jev to learn:

```text
model A is fastest for task X
model B succeeds more often at task Y
model C is expensive but worth using for task Z
```

Do not implement a complex learning system unless an existing one already exists.

But capture the telemetry required to support it later.

---

# ASTRA BUDGET TARGET

Create an explicit operational target:

> Astra should normally consume only a minority of the total agent tokens in a multi-agent run.

Do not fake precise cost guarantees if provider usage metrics are unavailable.

Where metrics exist, expose:

```text
astra_token_share
worker_token_share
astra_invocation_count
astra_context_bytes
```

This should make regressions visible.

---

# ROUTING OBSERVABILITY

Every delegation should be explainable.

Record:

```text
task
classification
chosen role
chosen model
provider
why selected
fallback chain
attempt number
duration
result
verification state
```

Example:

```text
TASK: repair bank observation regression
TYPE: bug-fix
COMPLEXITY: medium
RISK: high

PRIMARY:
deepseek-v4.1-flash

WHY:
debugging/root-cause specialist

FALLBACK:
glm-5.3 (verified non-Modal route)
gpt-5.6-sol
claude-sonnet-5

CAPACITY POLICY:
deepseek-non-modal-fallback; 429 advances immediately after safe reconciliation

REVIEW:
gpt-5.6-sol

ASTRA:
final gate only
```

This information should be inspectable without dumping verbose reasoning traces.

---

# ROUTING CONFIGURATION

Model policy must be configurable.

Model and reasoning effort must be equally easy to change. Support role presets,
per-candidate effort, one-task overrides and explicit lead-model selection.
Preserve active task snapshots and validate settings against the selected route.
Do not require source edits or machine-wide setting mutations to swap a worker.

Prefer a single file or existing configuration system.

Possible conceptual shape:

```yaml
roles:
  lead:
    primary: astra

  fast:
    primary: gemini-flash
    fallbacks:
      - glm-flash

  implementation:
    primary: sonnet
    fallbacks:
      - sol
      - glm
    optional_fallbacks:
      - kimi

  debug:
    primary: deepseek-flash
    fallbacks:
      - glm
      - sol
      - sonnet
    capacity_failure_policy: deepseek-non-modal-fallback

  review:
    models:
      - sol
      - opus
      - glm
```

Do not scatter model names throughout source code.

---

# SECURITY / CREDENTIALS

Never commit:

* API keys
* provider tokens
* Cloudflare credentials
* Modal credentials
* Anthropic credentials
* Google credentials
* OpenAI credentials

Reuse existing environment/configuration handling.

Logs must redact secrets.

---

# IMPLEMENTATION PHASES

## PHASE 1 — AUDIT

Produce a factual map of:

* current Codex Router plumbing;
* Prism/Jev;
* model registry;
* Kiro Prism integration;
* subagents;
* retry/fallback systems;
* provider health;
* context handling;
* worktree behavior;
* telemetry.

Do not stop after this phase.

---

## PHASE 2 — DEFINE CONTRACTS

Create or consolidate:

```text
TaskClassification
RoutingDecision
ModelRole
ExecutionRequest
ExecutionResult
VerificationResult
ProviderHealth
EvidencePacket
```

Reuse existing Prism decision, assessment, task-ledger and child-state equivalents.
Add engineering metadata and evidence gates rather than another authority.

---

## PHASE 3 — ROLE REGISTRY

Implement centralized role → model policy.

Ensure config overrides are possible.

---

## PHASE 4 — JEV ROUTING

Connect the existing Prism decision endpoint, multi-provider Jev fallback and
semantic assessment to deterministic engineering role/model/effort/strategy
selection. Reuse the existing gateway-specific wire translation and harden its
fallback error policy, total deadline and serving-gateway provenance.

---

## PHASE 5 — CODEX ROUTER EXECUTION

Connect routing decisions to Codex's installed child/thread lifecycle interface
and the Router's existing model-pinned agent publication. Router HTTP forwarding
does not own child lifecycles or worktree scheduling.

Do not invent unsupported APIs.

Discover the installed interface and use it correctly.

---

## PHASE 6 — PROVIDER FALLBACK

Reuse bounded transport retry, health state and model fallback, then implement
the missing safe task-level recovery and combined attempt deadline.

Pay particular attention to Modal:

```text
Kimi K3
DeepSeek V4.1 Flash
```

because these routes occasionally return busy/429 responses.

---

## PHASE 7 — CONTEXT GUARD

Prevent Astra from receiving unnecessary raw context.

Implement:

* file pointers;
* context packets;
* result packets;
* log summarization;
* diff summarization;
* selective escalation.

---

## PHASE 8 — WORKER STRATEGIES

Implement/adapt:

```text
single
swarm
arena
pipeline
interrogate
```

Do not force multi-agent execution onto tasks that do not benefit from it.

---

## PHASE 9 — INTEGRATION

Create a non-Astra integration path using Sol/Sonnet or equivalent.

---

## PHASE 10 — VERIFICATION

Require deterministic proof before completion.

---

## PHASE 11 — OBSERVABILITY

Instrument:

```text
routing
latency
failures
fallbacks
provider capacity
model usage
Astra usage
verification outcomes
```

---

## PHASE 12 — TESTS

Add deterministic tests covering at minimum:

### Routing

* low-complexity task avoids Astra execution;
* architecture task can route through Astra;
* debugging favors configured debugger;
* mechanical task favors cheap/fast worker;
* high-risk task requires independent review.

### Fallback

* Kimi 429 falls back;
* every DeepSeek assignment inherits the non-Modal capacity fallback, including
  role presets, task overrides, review/test roles and later fallback positions;
* DeepSeek 429 with or without Retry-After falls back to eligible GLM/Sol/Sonnet;
* exhausted or ineligible fallbacks terminate with evidence rather than retrying
  DeepSeek indefinitely, selecting Kimi by default or violating reviewer diversity;
* provider timeout falls back;
* auth failure does not blindly retry;
* model-quality failure can escalate families.

### Astra budget

* worker output is summarized before final lead handoff;
* giant logs are not injected into lead context;
* raw artifacts remain retrievable;
* routine worker retry does not unnecessarily invoke Astra.

### Parallel safety

* workers have isolated writable surfaces;
* conflicting writes are caught or prevented;
* integration happens through the integration stage.

### Verification

* a worker cannot mark a failed test run as complete;
* review cannot override deterministic failing tests;
* completion requires the configured acceptance gates.

---

# DOCUMENTATION

Create/update documentation explaining:

## System architecture

```text
Astra
 ↓
Jev
 ↓
Codex Router
 ↓
worker models
 ↓
verification
 ↓
review
 ↓
Astra
```

## Role definitions

Explain why each model class exists.

## Adding a model

Document how a future model can be:

```text
registered
health-checked
assigned a role
given fallbacks
evaluated
enabled
```

## Disabling a bad route

Make it trivial to temporarily remove a model/provider from routing.

---

# IMPORTANT ENGINEERING CONSTRAINTS

Do NOT:

* rewrite Codex Router;
* duplicate Kiro Prism;
* duplicate existing provider abstractions;
* vendor Cursor-specific pstack runtime code;
* assume Cursor's `Task` API exists;
* hard-wire model names across many files;
* make Astra the default coder;
* dump entire worker transcripts into Astra;
* endlessly retry Modal 429 responses;
* allow workers to silently overwrite one another;
* claim success because code merely compiles;
* stop after producing an architecture document.

Implement the working system.

---

# DESIRED FINAL BEHAVIOR

I should eventually be able to run Codex with:

```text
GPT-6 Astra
```

as the lead model and give it a request such as:

```text
Fix every remaining issue in this repository,
verify the entire application, and don't stop
until the acceptance criteria are satisfied.
```

Astra should behave like a principal engineer.

It should NOT personally grind through the entire repository.

Instead it should:

```text
1. understand the mission;
2. establish invariants;
3. ask Jev for task/risk intelligence;
4. create the execution graph;
5. send repo exploration to Gemini Flash;
6. send cheap/mechanical work to Gemini/GLM Flash;
7. send substantial implementation to Sonnet/GPT workers, with Kimi reserved for optional specialist work;
8. use DeepSeek for debugging when appropriate;
9. transparently fall back if Modal is busy;
10. use Sol as deputy lead/integrator;
11. use Opus selectively for independent high-value judgment;
12. run deterministic verification;
13. use multi-model review where warranted;
14. receive a compressed evidence packet;
15. inspect only the critical details;
16. make the final engineering decision.
```

The result should feel like:

```text
GPT-6 Astra
Principal Engineer

        ↓

Prism/Jev
Engineering Manager + Router

        ↓

Gemini / GLM / Kimi / DeepSeek /
GPT-5.6 / Sonnet
Engineering Team

        ↓

Sol / Sonnet
Integration Engineer

        ↓

Sol / Opus / alternate family
Review Board

        ↓

Tests / runtime evidence
Source of truth

        ↓

GPT-6 Astra
Final engineering gate
```

---

# FINAL ACCEPTANCE CHECKLIST

Do not report completion until all applicable items are proven.

* [x] Astra can remain the parent/lead model.
* [x] Jev produces structured routing decisions.
* [x] Codex Router executes alternate models.
* [x] Gemini 3.8 Flash works as the default direct-API fast worker.
* [x] GLM 5.3 works through Cloudflare Workers AI.
* [x] GLM 5.3 Flash works through Cloudflare Workers AI.
* [x] Kimi K3 works through the existing Kiro Prism/Modal path at a supported
  high effort. It remains an optional specialist rather than a routine worker;
  unsupported medium effort is rejected before work begins.
* [x] DeepSeek V4.1 Flash is integrated through the existing Kiro Prism/Modal
  path. Its live primary probe exhausted with HTTP 429, so it is currently
  capacity-excluded; production fault injection proves safe pre-output 429
  recovery through eligible full GLM, Sol and Sonnet routes.
* [x] Opus 5 works through the existing Kiro Prism models API.
* [x] Sonnet 5 works through the existing Kiro Prism models API.
* [x] GPT-5.6 workers remain available.
* [x] Model selection is role-based.
* [x] Model names are centrally configured.
* [x] Model/provider/effort assignments and fallback order are editable policy.
* [x] Per-task effort overrides do not leak across concurrent workers.
* [x] Unsupported effort levels are rejected before dispatch.
* [x] Existing Jev multi-provider fallback is reused with recorded gateway outcomes.
* [x] Modal 429/busy responses trigger bounded retry/fallback.
* [x] Every DeepSeek V4.1 Flash assignment has a validated non-Modal fallback;
  fault injection proves 429 recovery, checkpoint preservation and bounded exhaustion.
* [x] Provider health is observable.
* [x] Parallel workers are isolated.
* [x] Swarm execution works.
* [x] Arena execution works.
* [x] Multi-model interrogation/review works.
* [x] Integration does not require Astra to perform routine edits.
* [x] Deterministic verification gates completion.
* [x] Large logs are summarized before reaching Astra.
* [x] Raw evidence remains retrievable.
* [x] Astra invocation count is visible.
* [x] Astra token/context usage is observable where technically possible.
* [x] Routine tasks do not unnecessarily escalate to Astra.
* [x] High-risk tasks still require a bounded judgment-only Astra decision.
* [x] Tests cover routing and provider failure.
* [x] Documentation explains the architecture.
* [x] No secrets were committed.
* [x] Existing functionality remains intact across the full Ubuntu, macOS and
  Windows test jobs, both Electron packages, the unified macOS application,
  installed doctor, and macOS Homebrew source installation.

---

# EXECUTION INSTRUCTION

Begin by auditing the real repository and identifying the existing seams.

Then implement the architecture end-to-end.

Maintain a task checklist as you work.

Do not stop at recommendations.

Do not create a parallel replacement system when an existing abstraction can be extended.

Use the actual models and APIs available in this environment.

When a model identifier or provider API differs from this prompt, use the actual detected implementation rather than inventing compatibility.

At completion, return:

1. exact architecture implemented;
2. files added;
3. files changed;
4. model-role matrix;
5. fallback matrix;
6. how Astra context/token usage was constrained;
7. how Jev participates in each delegation;
8. verification commands and results;
9. provider/model routes actually tested;
10. any routes that remain unavailable;
11. remaining risks;
12. final git status and commits.
