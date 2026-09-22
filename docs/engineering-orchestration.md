# Engineering orchestration

Codex Router's engineering orchestration layer turns one engineering objective
into versioned assignments, isolated worker attempts, deterministic checks,
independent review, and a bounded evidence packet for the lead. It is an
explicitly enabled workflow layer over the existing Router and Kiro Prism. It
does not replace the Router's provider catalog, copy provider credentials, or
change ordinary Codex model selection while it is disabled.

This document describes the checked-in policy and core module contracts. A
catalog entry, a configured route, or a passing unit test is not evidence that
the corresponding live provider has answered a request. Treat a route as live
only after the deployment and revision being used have their own health and
request evidence.

## Architecture and authority boundaries

```text
Codex lead
  creates the objective, constraints, and acceptance criteria
       |
       v
Prism / Jev decision lane
  answers bounded typed questions about task risk and shape
       |
       v
deterministic engineering policy
  resolves role, exact route, effort, fallbacks, and review rules
       |
       v
scheduler and lifecycle adapter
  records intent, leases writable scope, dispatches, and recovers
       |
       v
Codex Router -> selected provider route -> isolated worker
       |
       v
integration -> deterministic verification -> independent review
       |
       v
revision-bound, bounded evidence packet -> Codex lead
```

The boundaries matter:

- The lead owns the objective, architecture choices that remain genuinely
  ambiguous, and final acceptance.
- Jev classifies a supplied state. It can return Noul probabilities, a choice
  distribution, or a rubric score. It does not create a task graph, choose an
  unregistered model, authorize a command, execute code, or declare a test
  successful.
- The engineering policy converts a typed assessment plus current catalog and
  runtime facts into an assignment. Model eligibility, effort support, fallback
  order, and reviewer diversity are deterministic checks.
- The scheduler owns task dependencies, admission, exact dispatch identity,
  writer leases, fencing, cancellation, and reconciliation.
- The Router remains the only model gateway. Shell, file, Git, and collaboration
  tools execute through the Codex runtime under its permissions, never inside
  the HTTP gateway.
- Verification and review must refer to the exact integrated revision. A model's
  confidence and a worker's statement that a task passed are supporting claims,
  not acceptance gates.

The current core lives in `src/engineering/`:

| Module | Responsibility |
| --- | --- |
| `contracts.mjs` | Versioned immutable record shapes for tasks, decisions, bindings, results, reviews, and evidence. |
| `policy-state.mjs` | Owner-only, atomic, compare-and-swap policy state. |
| `policy.mjs` | Policy validation and exact assignment resolution. |
| `prism-decisions.mjs` | Bounded Prism request/response validation, deadline handling, and Jev gateway provenance. |
| `execution-binding.mjs` | Immutable bridge from one resolved assignment to one exact Codex execution. |
| `codex-executor.mjs` | Codex app-server JSON-RPC transport and thread/turn lifecycle adapter. |
| `scheduler.mjs` | Dependency admission, durable dispatch ordering, leases, cancellation, and runtime reconciliation. |
| `worktrees.mjs` | Managed Git worktrees, path ownership, fencing, integration, and guarded cleanup. |
| `strategies.mjs` | Single, swarm, pipeline, arena, and interrogation workflow graphs. |
| `state.mjs` | Owner-only task state machine with legal transitions and fencing tokens. |
| `artifacts.mjs` | Immutable, digest-addressed evidence artifacts and manifests. |
| `evidence.mjs` | Revision-bound acceptance evaluation and bounded lead packets. |
| `telemetry.mjs` | Correlated usage events with measured, estimated, and unknown values. |

## Opt-in behavior

Engineering orchestration is off by default. The checked-in defaults at
`config/engineering-policy.defaults.json` contain `"enabled": false`. With no
mutable state file, `readEngineeringPolicyState()` returns those defaults at
revision `0` with status `default`.

When the policy is off, `resolveEngineeringAssignment()` returns
`status: "disabled"`. The caller must continue through the normal Codex/Router
path. It must not create engineering tasks, rewrite the user's selected model,
spawn workers, call Jev for engineering routing, or alter per-model effort
defaults as a side effect.

Enabling the policy is a deliberate state update. The mutable document is
`engineering-policy.json` under the Router state directory. It is written
owner-only under an owner-only directory, and every update requires the exact
current revision. A stale writer receives a `revision_conflict` instead of
overwriting a newer choice.

```js
import {
  readEngineeringPolicyState,
  updateEngineeringPolicy,
} from "../src/engineering/policy-state.mjs";

const current = readEngineeringPolicyState();
const enabled = updateEngineeringPolicy(
  (policy) => ({ ...policy, enabled: true }),
  { expectedRevision: current.revision },
);
```

Operators normally use the revision-guarded control surface:

```text
bin/model-router codex engineering status
bin/model-router codex engineering on --revision N
bin/model-router codex engineering off --revision N
bin/model-router codex engineering policy
bin/model-router codex engineering policy replace --file POLICY.json --revision N
bin/model-router codex engineering preview ROLE --model SLUG --effort LEVEL
bin/model-router codex engineering usage
```

The `policy` output is a sanitized editable document. Change the candidate
order, model slug, provider route, optional-model list, preset, or supported
effort and use `policy replace` with the current revision. Replacement is atomic
and validated before publication; an invalid or stale document leaves the prior
policy byte-identical. The Control Center and macOS tray expose the same
default-off toggle through the shared `catalog.engineering` snapshot. They do
not replace an active Codex model or require a restart.

Disabling uses the same compare-and-swap update with `enabled: false`. It stops
new engineering assignments. Existing attempts retain their immutable binding
and policy revision; disabling does not silently change a running child's model
or effort. The lifecycle controller must cancel or reconcile active attempts
through their recorded bindings when the operator wants them stopped.

Policy read errors fail closed. An unreadable, malformed, unsupported, or
non-private mutable policy produces `status: "degraded"`, `degraded: true`, and
`enabled: false`. Repair the file or replace it through the validated state API;
do not route using a partially parsed policy.

Enabling the engineering policy makes routing automatic only inside a new
engineering run: task classification and role resolution happen as tasks become
assignable. It does not hot-swap the model driving an already active Codex
parent. Changing the lead requires the Codex-supported model selection or a new
session.

## Pinned and adaptive routing

Pinned mode resolves each role to an ordered list of exact Router slugs. This is
the policy resolver's checked-in behavior. Resolution validates the current
catalog, selected/configured set, offered Codex agent binding, capabilities,
effort levels, optional-model gate, family rules, and DeepSeek recovery rule.
The first eligible exact route wins, and every rejection is retained with its
reason.

Adaptive mode is optional. It may be used only through an explicitly registered,
configured, eligible adaptive route whose request and result contract has been
verified. A catalog record that happens to use `auto` is not sufficient proof.
Adaptive selection remains inside Prism; Codex must record the route requested,
the actual serving route when Prism exposes it, and the same acceptance evidence
as a pinned assignment.

These modes do not blur together:

- A pinned candidate never changes model merely because Prism has an adaptive
  pool.
- An adaptive candidate is a named policy candidate, not a hidden fallback for
  an arbitrary pinned route.
- Provider health and policy eligibility can remove a candidate before
  dispatch; they cannot invent a replacement outside the ordered policy.
- Running attempts keep their resolved snapshot when policy or adaptive pool
  membership changes.

Until an adaptive route has end-to-end publication, dispatch, provenance, and
recovery evidence for the installed revision, operate the engineering workflow
in pinned mode.

## Roles, models, and effort

The checked-in presets are `fast`, `balanced`, and `deep-review`. `balanced` is
the selected default preset even while the feature itself is disabled. Presets
are editable policy bundles; they are not model aliases and do not grant a route
capabilities it does not advertise.

The lead is configured separately at top-level `lead` because it is the native
Codex parent rather than a routed child. The default is:

```json
{
  "executionMode": "native-parent",
  "model": "gpt-6-astra",
  "effort": "default"
}
```

`resolveEngineeringLead()` requires exactly one offered inventory binding for
that model with `nativeParent: true`, `executionMode: "native-parent"`, and a
supported effort. It has no silent fallback and cannot turn a routed child into
the active parent. A lead override applies to that new run only.

Routed child roles are independent configuration points:

- `architecture` handles architecture analysis and alternatives.
- `fast_general_worker`, `repo_explorer`, `mechanical_worker`, and `prose_docs`
  handle bounded discovery, mechanical changes, and documentation.
- `general_coder` and `complex_coder` own implementation of increasing scope.
- `debugger` owns reproduction and root-cause work.
- `test_author` owns test design and implementation.
- `reviewer` provides independent review and can require a different model
  family from the author.
- `integrator` owns the integration checkout.
- `deputy_lead` handles routine orchestration delegated by the lead.
- `synthesizer` compresses worker results and logs without replacing immutable
  evidence.

Each role has ordered `candidates` and may have `optionalCandidates`. Every
candidate names the exact Router slug and its own effort:

```json
{
  "candidates": [
    { "model": "kiro-prism/claude-sonnet-5", "effort": "high" },
    { "model": "kiro-prism/gpt-5.6-sol", "effort": "high" },
    { "model": "cloudflare-workers-ai/glm-5.3", "effort": "high" }
  ],
  "optionalCandidates": [
    { "model": "kiro-prism/kimi-k3", "effort": "high" }
  ]
}
```

Use a workspace role entry to replace that role in the selected preset without
editing source. Reordering the array changes fallback priority. Set
`disabled: true` on a candidate for a reversible route-specific suppression, or
remove it from the role. `minimumCapabilities` can require features such as
tools or vision. The validator rejects unknown fields, aliases, unlisted model
slugs, duplicate candidates, and explicit efforts that the selected route does
not advertise.

Effort resolution for the selected candidate is:

1. attempt override;
2. task override;
3. role candidate effort;
4. `operatorModelDefaults[exactModelSlug]`;
5. the route's advertised default.

`"default"` clears the explicit effort at that scope and continues down the
chain. It is never sent upstream as a fabricated reasoning level. When no
advertised effective level is available, the binding records `unknown` rather
than guessing. Fallback candidates retain their own effort settings; an effort
valid for the failed route is not copied to them.

Policy changes apply to new assignments. An `ExecutionBinding` records the
policy revision, preset, role, exact model, provider, agent type, requested and
effective effort, effort source, attempt, worktree, branch, and dispatch
identity. Concurrent attempts may therefore use the same model at different
efforts without mutating a shared per-model default, provided the execution
adapter enforces that binding.

The checked-in Codex app-server adapter starts a non-ephemeral thread at the
binding's model, provider, worktree, and effort, starts a turn, persists the
returned thread and turn identities, and supports read, resume, fork, interrupt,
and terminal-notification waits. It never obtains its routing identity from the
worker prompt. Installed Codex versions must still be contract-tested before
that adapter is described as live on a particular host.

### Kimi K3 is sparse and optional

Kimi K3 is deliberately absent from the normal candidate chain. It appears in
`optionalCandidates` for bounded specialist or alternate-review work. It becomes
eligible for ordinary role resolution only when its exact slug is present in
`enabledOptionalModels`. An explicit task or attempt override can select it for
that one assignment, subject to normal catalog, binding, capability, effort, and
health checks.

Large size or multi-file implementation is not by itself a reason to choose
Kimi. The balanced substantial-implementation choices are Sonnet and GPT-5.6
routes. Kimi must never become a blocking dependency or the automatic capacity
fallback for DeepSeek.

### DeepSeek requires non-Modal recovery

Every assignment that resolves to upstream `deepseek-v4.1-flash` inherits
`capacityFailurePolicy: "deepseek-non-modal-fallback"`. The policy resolver
rejects the DeepSeek candidate unless a later eligible candidate:

- belongs to a different model family; and
- has a capacity host other than `modal`.

The default debugger order is DeepSeek, a full GLM route identified as
non-Modal, GPT-5.6 Sol, and Sonnet. A second gateway that still serves the same
saturated Modal backend does not satisfy the rule. Kimi is not inserted into
this chain.

At execution time, a capacity failure such as HTTP 429, with or without
`Retry-After`, must stop or reconcile the current attempt, preserve its
checkpoint, and advance within one total recovery deadline. An ambiguous
post-dispatch outcome is reconciled before replacement. Exhaustion is recorded
as evidence; it must not loop indefinitely or silently escalate the coding work
to the lead. The resolver proves policy shape and current eligibility. Fault
injection and a live deployment check are still required before claiming that a
particular deployed route completed this recovery.

## Jev's typed decision role

The engineering controller uses Kiro Prism's authenticated `/v1/decisions`
surface with a 1.5 second default client deadline. Provider credentials stay
server-side in Prism. Codex sends Prism's existing request contract:
object-shaped `state` capped at 65,536 bytes, logical provider `typesafe`, model
`jev-latest`, and one to 64 typed questions using `question`, explicit choice
`options`, and criteria.

Prism owns the TypeSafe, Vercel AI Gateway, and OpenRouter fallback chain. Codex
does not call those vendors directly or copy their keys. The controller records
the assessment request ID, question-pack version, objective/context hash, policy
revision, candidate snapshot, confidence/probability fields, provider outcome
provenance when returned, and whether conservative routing was used.
The client rejects a success response unless its request ID and answer set match,
Noul/choice/score values are valid, and the final provenance attempt is a
successful `typesafe`, `vercel`, or `openrouter` attempt matching
`serving_gateway`. Responses are capped at 1,000,000 bytes.

Jev output is advisory input to deterministic policy. Low confidence,
insufficient context, an unavailable classifier, or an ambiguous upstream
outcome selects a conservative configured role or stops according to policy; it
does not relax verification, credentials, path ownership, or review. Reuse a
decision for unchanged retries. Re-evaluate only when the task meaning, context,
question version, policy version, or candidate set changes.

The three-provider adapter and tests establish a source-level integration. They
do not by themselves prove that a hosted Prism revision has the keys, has been
restarted, or currently reaches all three endpoints. Use gateway provenance and
bounded deployed probes for that claim.

## Isolation and workflow strategies

Every concurrent writer gets a disjoint repository-relative ownership set and
an isolated checkout. `assertNoOwnedPathConflicts()` rejects exact, parent/child,
case-equivalent, traversal, and symlink-based overlaps before work starts.
Read-only workers may share a checkout when the runtime really enforces
read-only behavior.

Router-managed worktrees are created outside the repository checkout from an
exact base commit. Their records include an ownership token and monotonically
checked fence. The integration owner alone may cherry-pick a candidate, only
after confirming the integration head and that the candidate changed no path
outside its ownership. Conflicts produce `needs_remediation`; they are not
automatically accepted. Cleanup requires the exact token/fence, a durably
recorded and reconciled result, a clean worktree, and a matching registered Git
worktree. Host-managed worktrees are never deleted by the Router.

The workflow compiler supports:

- `single`: one bounded task followed by verification and optional review.
- `swarm`: two or more disjoint writable slices, an explicit integration owner,
  an all-success join, verification, and review.
- `pipeline`: dependency-ordered stages followed by synthesis, verification,
  and review.
- `arena`: bounded competing implementations of the same brief in separate
  worktrees. Deterministic gates remove failing candidates before a judge can
  select a winner. A tie or invalid winner requires adjudication.
- `interrogate`: independent, family-diverse reviews of one revision. Findings
  are deduplicated by invariant/location/reproducer and reproducible blocking
  findings cannot be voted away.

Parallelism is admission-controlled by the smallest current bound among ready
tasks, runtime slots, operator limit, provider slots, and host slots. The
scheduler records assignment intent and writer fences before dispatch. A child
result is recorded before its completion notification releases leases.

## Deterministic acceptance

Acceptance is bound to one exact revision. `evaluateEngineeringAcceptance()`
requires:

- at least one recorded worker result for that revision;
- every required verification result, on that revision, with a passing status;
- required review on that revision with no unresolved blocking finding;
- a lead `accept` decision on that revision unless the caller explicitly
  configures a workflow where lead acceptance is not required; and
- every acceptance gate to be true with no blockers.

Missing, skipped, timed-out, stale, errored, or nonzero-exit verification is not
a pass. A worker's self-reported success is recorded but never makes acceptance
true. Any relevant code change produces a new revision and invalidates earlier
verification, review, and lead decisions. Multi-worker work must be integrated
and rechecked at the integrated revision.

`acceptEngineeringTask()` accepts only from `verifying`, `reviewing`, or
`integrating`, requires the current lease fence, and rejects a revision mismatch
or any false gate. Legal state transitions are persisted with reasons; callers
cannot jump directly from work to accepted.

## Context and evidence bounds

The lead receives a structured packet rather than raw worker transcripts.
Current hard bounds are:

- 24 KiB for the complete JSON evidence packet;
- 8 KiB for its summary; and
- 8 KiB total for critical excerpts.

Unresolved failures and raw artifact references are never silently discarded.
If those mandatory fields cannot fit, packet creation fails. Summaries and
excerpts can be truncated with an explicit truncation marker while the complete
raw output remains in immutable artifacts.

Artifacts are owner-only regular files under a caller-supplied safe root. Paths
must be relative and may not contain empty, dot, traversal, absolute, or symlink
components. Files are immutable after creation and referenced by size and
SHA-256. Manifests have their own digest. Retrieval verifies the path, type,
size, digest, and a 16 MiB default read limit.

Worker briefs should carry the objective, acceptance criteria, exact base
revision, owned paths, relevant file pointers, constraints, task-local evidence,
and the expected result schema. Store long logs, full diffs, and command output
as artifacts. The synthesizer may compress them, but cannot edit away an
unresolved failure or replace a digest-bound record.

## Provider health and fallback

Keep these states separate in status and logs:

1. **Listed**: the route exists in the checked-in/current catalog.
2. **Configured**: its provider is selected and credential prerequisites are
   present.
3. **Offered**: Codex exposes one exact agent type bound to the same route slug.
4. **Eligible**: policy, capability, effort, optional-model, diversity, and
   current health checks permit assignment.
5. **Live-proven**: a bounded request on the deployed revision succeeded.

Catalog presence is never health. A failed route should enter the existing
provider/model cooldown and become ineligible for later tasks. Cross-task
circuit behavior needs a bounded half-open probe before restoring eligibility.
Record provider, model, capacity host, failure class, attempt, cooldown, and the
actual serving route where observable. Redact credentials and secret-bearing
URLs.

Transport retry is legal only before response bytes are relayed. Task-level
recovery operates on checkpoints and execution bindings after the prior attempt
is safely resolved. Authentication/configuration errors, confirmed capacity
errors, ambiguous outcomes, and model-quality failures have different policies;
do not treat every error as permission to submit the same decision or coding
request to another provider.

## Adding, changing, or disabling a route

Adding a future worker route is a staged operation:

1. Register the provider/model through the existing Router or Kiro Prism
   catalog, including exact effort and capability metadata. Do not add a second
   direct provider integration when Prism already owns the route.
2. Configure its credential through the existing protected provider path.
3. Refresh the Router catalog and verify that the exact route is selected,
   configured, and published to the intended Codex execution binding.
4. Run the route's bounded health/live proof and record the deployed revision.
5. Add the exact slug to the relevant role candidate list with its own effort,
   fallback position, minimum capabilities, family rules, and capacity host.
6. Validate and preview assignment resolution, including every rejection and
   fallback.
7. Evaluate it on representative tasks with deterministic gates before making
   it a primary candidate.
8. Activate the policy using a compare-and-swap update. Existing attempts keep
   their prior snapshot.

To disable one bad route, set that candidate's `disabled` flag or remove it from
the role/workspace override and publish a new policy revision. To disable an
optional model everywhere, remove its slug from `enabledOptionalModels`. To stop
all new orchestration, set top-level `enabled` to false. Disabling a model in the
engineering policy does not erase its provider credential or remove it from
ordinary Router clients.

Before changing a DeepSeek fallback, preview the resolved candidate list. The
resolver will reject DeepSeek if the edit removes its later eligible non-Modal
route. Before changing a reviewer, resolve it with the actual author binding so
high-risk same-family review cannot slip through.

## Crash recovery

The durable ordering is intentional:

1. create the task and dependency graph;
2. record assignment intent, exact attempt/operation IDs, and writer fences;
3. dispatch the runtime child;
4. record the returned result against the exact attempt and fences;
5. release writer ownership;
6. integrate, verify, review, and accept the exact revision.

After a controller crash, call scheduler reconciliation for tasks in assigned,
running, or cancelling states. Runtime inspection that returns unknown, times
out, or itself fails is not evidence that the child stopped. Preserve the
binding and leases and inspect again with bounded backoff. A confirmed running
child is recovered. A confirmed completed child is recorded once. A stale or
foreign late result is retained as `nonIntegrable` evidence and cannot mutate
the integration checkout.

Dispatch failures marked `dispatched: false` may retry within the attempt limit.
An ambiguous dispatch keeps its identity for reconciliation; starting a
replacement immediately could create two writers. Cancellation likewise becomes
final only when the runtime confirms the attempt stopped. Fencing prevents an
old controller or late worker from committing after ownership moves.

Task state and scheduler state adapters must be durable in unattended use. The
included memory scheduler adapter is for tests and foreground runs; it is not a
crash-recovery claim.

## Observability

Every assignment should be inspectable without exposing hidden reasoning or
credentials. Record at least:

- run, task, parent task, attempt, and dispatch operation IDs;
- classification request/version, chosen role, strategy, and policy revision;
- selection source, exact model/provider/agent type, model family, capacity
  host, requested/effective effort, and effort source;
- eligible candidates, rejected candidates with reasons, and ordered fallbacks;
- Jev gateway provenance and calibrated values where the deployed Prism response
  supplies them;
- worktree/base/result/integrated revisions and owned paths;
- start/finish times, duration, retry/failure class, circuit state, and actual
  serving route where observable;
- verification gates, review findings/disagreements, acceptance blockers, and
  artifact references; and
- per-attempt usage plus lead-context bytes/tokens where the runtime exposes
  them. Record `unknown` instead of estimating an unsupported metric.

Usage values retain one of three kinds: `measured`, `estimated`, or `unknown`.
Duplicate Router, Prism, and native observations for the same provider or
Router request are merged before totals are computed, preferring measured over
estimated over unknown. The summary reports the count of unknown observations
instead of converting them to zero.

For requested parallel execution, retain actual child start and finish times so
the run can prove that at least two intervals overlapped. A configured capacity
larger than one is not concurrency evidence.

## Troubleshooting

**Status is `disabled`.** The policy is using its safe default or has been
explicitly turned off. Read the current policy revision and enable it through a
compare-and-swap update if an engineering run is intended.

**Status is `degraded`.** The mutable policy is malformed, has an unsupported
schema, is not owner-only, or cannot be read. Fix ownership/content or replace
it through `replaceEngineeringPolicy()` using the current revision. Routing
remains off until the read is clean.

**Resolution is `exhausted`.** Inspect `rejectedCandidates`. Common causes are an
unselected provider, missing credential, a route not currently offered as the
expected agent type, an alias instead of the exact slug, an unsupported effort,
a missing capability, a disabled optional model, same-family review, health
cooldown, or missing DeepSeek non-Modal fallback.

**An effort edit is rejected.** Use only the levels advertised by that exact
route. Set `default` to clear the explicit scope. Do not copy an effort from a
different provider/model even when the readable model name is similar.

**Kimi is never selected.** Confirm its exact slug is configured/offered and add
it to `enabledOptionalModels`, or use a one-task override. Its sparse behavior is
intentional.

**DeepSeek is rejected.** Ensure a later eligible fallback has a different
family and `capacityHost` other than `modal`. Confirm that the advertised
non-Modal identity reflects the real backend rather than a second gateway to
Modal.

**A completed result is non-integrable.** Its attempt ID, operation ID, task
revision, or writer fences no longer match the active binding. Preserve it as a
late artifact; never cherry-pick it automatically.

**A task remains assigned after restart.** Reconcile the recorded runtime child.
Do not clear leases or spawn a replacement based on an inspection timeout.

**Verification passed before a final edit.** It is stale. Run the required gates
again on the new integrated revision and obtain revision-matched review and lead
acceptance.

**Jev is unavailable.** Use the configured conservative classification path and
record the outage. Do not bypass verification or connect Codex directly to one
of Jev's underlying vendor credentials.

**Health says ready but requests fail.** Configuration readiness is not a live
probe. Check the deployed revision, endpoint-specific outcome, circuit/cooldown,
and a bounded request without printing keys.

## Preservation and removal

Engineering policy and task state belong to the shared Router plane, not to a
single client target. Install, refresh, repair, and catalog publication must
preserve an existing policy revision, optional-model choices, workspace role
overrides, running task bindings, evidence artifacts, unrelated provider
credentials, Codex settings, and ChatGPT authentication.

Turning the feature off is the normal reversible operation. It leaves policy,
history, and evidence available for audit and later re-enablement. Removing an
engineering route from a role leaves the underlying provider and other Router
clients unchanged.

Uninstall may remove only files and client configuration that the Router can
prove it owns. It must first reconcile or cancel active engineering attempts,
preserve any evidence the operator has elected to retain, and never delete a
host-managed or dirty worktree. Router-managed worktree cleanup still requires
its exact ownership token/fence and a durably recorded, reconciled result.
Uninstall must preserve unrelated Codex configuration, native authentication,
provider credentials outside the owned integration, and every unowned client
surface.
