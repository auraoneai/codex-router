import { immutableSnapshot } from "./contracts.mjs";

export const ENGINEERING_FAILURE_CLASSES = Object.freeze([
  "RATE_LIMIT",
  "BUSY",
  "TIMEOUT",
  "AUTH",
  "ENTITLEMENT",
  "BUDGET_EXHAUSTED",
  "MODEL_UNAVAILABLE",
  "PROTOCOL_ERROR",
  "TOOL_ERROR",
  "MODEL_QUALITY_FAILURE",
]);

const FAILURE_CLASSES = new Set(ENGINEERING_FAILURE_CLASSES);
const CAPACITY_FAILURES = new Set(["RATE_LIMIT", "BUSY", "TIMEOUT", "MODEL_UNAVAILABLE"]);
const DISPATCH_STATES = new Set(["pre_dispatch", "dispatched", "ambiguous"]);
const OUTPUT_STATES = new Set(["none", "started", "complete"]);
const TOOL_ACTION_STATES = new Set(["none", "safe", "ambiguous", "complete"]);

function finiteInteger(value, fallback = undefined) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function statusOf(error, context) {
  return finiteInteger(
    context.status ?? error?.status ?? error?.statusCode ?? error?.httpStatus ?? error?.response?.status,
  );
}

function combinedErrorText(error, context) {
  return [
    context.kind,
    context.code,
    context.message,
    error?.name,
    error?.code,
    error?.kind,
    error?.type,
    error?.message,
  ].filter((value) => typeof value === "string").join(" ").toLowerCase();
}

function classifiedFailure(status, text, explicitClass) {
  if (explicitClass !== undefined) {
    const normalized = String(explicitClass).toUpperCase();
    if (!FAILURE_CLASSES.has(normalized)) {
      throw new TypeError(`Unsupported engineering failure class ${JSON.stringify(explicitClass)}.`);
    }
    return normalized;
  }
  if (/quality|failed(?:[ _-](?:test|acceptance))?[ _-]gate|test[ _-]failure|incorrect|bad[ _-]answer/u.test(text)) {
    return "MODEL_QUALITY_FAILURE";
  }
  if (/schema|protocol|malformed|invalid[ _-](response|json)|parse/u.test(text)) return "PROTOCOL_ERROR";
  if (/tool/u.test(text)) return "TOOL_ERROR";
  if (/budget|credit|spend[ _-]limit|insufficient[ _-](funds|quota)/u.test(text) || status === 402) {
    return "BUDGET_EXHAUSTED";
  }
  if (/entitlement|plan[ _-]doesn.t|not[ _-]entitled|permission/u.test(text) || status === 403) {
    return "ENTITLEMENT";
  }
  if (/auth|credential|api[ _-]?key|unauthoriz/u.test(text) || status === 401) return "AUTH";
  if (/rate[ _-]?limit|resource[ _-]?exhausted|too[ _-]many/u.test(text) || status === 429) {
    return "RATE_LIMIT";
  }
  if (/timeout|timed[ _-]?out|deadline|aborterror/u.test(text) || status === 408) return "TIMEOUT";
  if (/busy|overload|capacity|try[ _-]again|conflict|too[ _-]early/u.test(text) || [409, 425].includes(status)) {
    return "BUSY";
  }
  if (status !== undefined && status >= 500 && status <= 599) return "MODEL_UNAVAILABLE";
  return "PROTOCOL_ERROR";
}

function normalizedDispatchState(error, context) {
  const explicit = context.dispatchState ?? context.dispatch_state ?? error?.dispatchState ?? error?.dispatch_state;
  if (explicit !== undefined) {
    if (!DISPATCH_STATES.has(explicit)) throw new TypeError(`Unsupported dispatch state ${JSON.stringify(explicit)}.`);
    return explicit;
  }
  const dispatched = context.dispatched ?? error?.dispatched;
  if (dispatched === false) return "pre_dispatch";
  if (dispatched === true || statusOf(error, context) !== undefined) return "dispatched";
  return "ambiguous";
}

function normalizedOutputState(error, context) {
  const explicit = context.outputState ?? context.output_state ?? error?.outputState ?? error?.output_state;
  if (explicit !== undefined) {
    if (!OUTPUT_STATES.has(explicit)) throw new TypeError(`Unsupported output state ${JSON.stringify(explicit)}.`);
    return explicit;
  }
  const bytes = finiteInteger(context.outputBytes ?? error?.outputBytes, 0);
  if (bytes > 0 || context.firstByte === true || error?.firstByte === true) return "started";
  return "none";
}

function normalizedToolActionState(error, context) {
  const explicit = context.toolActionState ?? context.tool_action_state ?? error?.toolActionState ?? error?.tool_action_state;
  if (explicit !== undefined) {
    if (!TOOL_ACTION_STATES.has(explicit)) {
      throw new TypeError(`Unsupported tool action state ${JSON.stringify(explicit)}.`);
    }
    return explicit;
  }
  if (context.ambiguousToolAction === true || error?.ambiguousToolAction === true) return "ambiguous";
  return "none";
}

export function parseRetryAfter(value, { now = Date.now(), capMs = 60_000 } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("Retry-After now must be finite.");
  if (!Number.isSafeInteger(capMs) || capMs < 0) throw new TypeError("Retry-After capMs must be a non-negative safe integer.");
  if (value === undefined || value === null || value === "") return undefined;
  let delay;
  if (typeof value === "number" && Number.isFinite(value)) delay = Math.max(0, value * 1_000);
  else if (typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*$/u.test(value)) {
    delay = Math.max(0, Number(value.trim()) * 1_000);
  } else {
    const date = Date.parse(String(value));
    if (!Number.isFinite(date)) return undefined;
    delay = Math.max(0, date - now);
  }
  return Math.min(capMs, Math.ceil(delay));
}

function retryAfterValue(error, context) {
  return context.retryAfter ?? context.retry_after ?? error?.retryAfter ?? error?.retry_after ??
    error?.headers?.get?.("retry-after") ?? error?.headers?.["retry-after"] ??
    error?.response?.headers?.get?.("retry-after") ?? error?.response?.headers?.["retry-after"];
}

export function normalizeEngineeringFailure(error, context = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("Engineering failure context must be an object.");
  }
  const status = statusOf(error, context);
  const failureClass = classifiedFailure(status, combinedErrorText(error, context), context.failureClass);
  const dispatchState = normalizedDispatchState(error, context);
  const outputState = normalizedOutputState(error, context);
  const toolActionState = normalizedToolActionState(error, context);
  // A completed response can support a later task-level remediation attempt.
  // A response that is still streaming cannot be transport-switched.
  const unsafeOutput = outputState === "started";
  const ambiguousSideEffect = toolActionState === "ambiguous" || toolActionState === "complete";
  const ambiguousDispatch = dispatchState === "ambiguous";
  const protocolBound = ["PROTOCOL_ERROR", "TOOL_ERROR", "AUTH", "ENTITLEMENT", "BUDGET_EXHAUSTED"].includes(failureClass);
  const quality = failureClass === "MODEL_QUALITY_FAILURE";
  const capacityFailure = CAPACITY_FAILURES.has(failureClass);
  const defaultRetryable = capacityFailure && !unsafeOutput && !ambiguousSideEffect && !ambiguousDispatch;
  const declaredRetryable = context.retryable ?? error?.retryable;
  const retryable = declaredRetryable === false ? false : (declaredRetryable === true ? !unsafeOutput && !ambiguousSideEffect && !ambiguousDispatch : defaultRetryable);
  const mayRetrySameRoute = retryable && dispatchState === "pre_dispatch" && !protocolBound && !quality;
  const independentProviderFailure = ["AUTH", "ENTITLEMENT", "BUDGET_EXHAUSTED"].includes(failureClass);
  const maySwitchRoute = !unsafeOutput && !ambiguousSideEffect && !ambiguousDispatch &&
    (capacityFailure || quality || independentProviderFailure);
  const retryAfterMs = parseRetryAfter(retryAfterValue(error, context), {
    now: context.now ?? Date.now(),
    capMs: context.retryAfterCapMs ?? 60_000,
  });
  return immutableSnapshot({
    failureClass,
    status,
    code: typeof (context.code ?? error?.code) === "string" ? (context.code ?? error.code) : undefined,
    dispatchState,
    outputState,
    toolActionState,
    retryable,
    mayRetrySameRoute,
    maySwitchRoute,
    requiresReconciliation: ambiguousDispatch || ambiguousSideEffect || unsafeOutput,
    capacityFailure,
    retryAfterMs,
  });
}

export class EngineeringAttemptBudget {
  #attemptLimit;
  #deadlineAt;
  #retryAfterCapMs;
  #attempts = [];
  #now;

  constructor({ deadlineMs, attemptLimit, retryAfterCapMs = 60_000, now = Date.now } = {}) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
      throw new TypeError("Engineering attempt deadlineMs must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(attemptLimit) || attemptLimit <= 0) {
      throw new TypeError("Engineering attemptLimit must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(retryAfterCapMs) || retryAfterCapMs < 0) {
      throw new TypeError("Engineering retryAfterCapMs must be a non-negative safe integer.");
    }
    if (typeof now !== "function") throw new TypeError("Engineering attempt clock must be a function.");
    this.#now = now;
    const startedAt = now();
    if (!Number.isFinite(startedAt)) throw new TypeError("Engineering attempt clock must return a finite timestamp.");
    this.#deadlineAt = startedAt + deadlineMs;
    this.#attemptLimit = attemptLimit;
    this.#retryAfterCapMs = retryAfterCapMs;
  }

  remainingMs(at = this.#now()) {
    return Math.max(0, Math.floor(this.#deadlineAt - at));
  }

  claim({ route, host, layer = "orchestrator", at = this.#now() } = {}) {
    if (typeof route !== "string" || !route.trim()) throw new TypeError("Attempt route must be a non-empty string.");
    if (typeof layer !== "string" || !layer.trim()) throw new TypeError("Attempt layer must be a non-empty string.");
    if (this.#attempts.length >= this.#attemptLimit) return immutableSnapshot({ ok: false, reason: "attempt_limit" });
    if (this.remainingMs(at) <= 0) return immutableSnapshot({ ok: false, reason: "deadline" });
    const attempt = immutableSnapshot({
      ordinal: this.#attempts.length + 1,
      route,
      host: typeof host === "string" && host.trim() ? host : undefined,
      layer,
      startedAt: at,
    });
    this.#attempts.push(attempt);
    return immutableSnapshot({ ok: true, attempt, remainingMs: this.remainingMs(at) });
  }

  boundedDelay(retryAfter, { at = this.#now(), fallbackMs = 0 } = {}) {
    const requested = retryAfter === undefined
      ? Math.max(0, finiteInteger(fallbackMs, 0))
      : (typeof retryAfter === "number"
        ? Math.min(this.#retryAfterCapMs, Math.max(0, Math.ceil(retryAfter)))
        : (parseRetryAfter(retryAfter, { now: at, capMs: this.#retryAfterCapMs }) ?? Math.max(0, finiteInteger(fallbackMs, 0))));
    const remainingMs = this.remainingMs(at);
    if (remainingMs <= 0) return immutableSnapshot({ ok: false, reason: "deadline", delayMs: 0 });
    return immutableSnapshot({ ok: true, delayMs: Math.min(requested, remainingMs), remainingMs });
  }

  snapshot(at = this.#now()) {
    return immutableSnapshot({
      attemptLimit: this.#attemptLimit,
      attemptsUsed: this.#attempts.length,
      deadlineAt: this.#deadlineAt,
      remainingMs: this.remainingMs(at),
      attempts: this.#attempts,
    });
  }
}

function scopeKeys(route, host) {
  if (typeof route !== "string" || !route.trim()) throw new TypeError("Circuit route must be a non-empty string.");
  const keys = [`route:${route.trim().toLowerCase()}`];
  if (typeof host === "string" && host.trim()) keys.push(`host:${host.trim().toLowerCase()}`);
  return keys;
}

export class EngineeringCapacityCircuits {
  #entries = new Map();
  #failureThreshold;
  #openMs;
  #retryAfterCapMs;
  #now;

  constructor({ failureThreshold = 2, openMs = 30_000, retryAfterCapMs = 60_000, now = Date.now } = {}) {
    if (!Number.isSafeInteger(failureThreshold) || failureThreshold <= 0) throw new TypeError("Circuit failureThreshold must be positive.");
    if (!Number.isSafeInteger(openMs) || openMs <= 0) throw new TypeError("Circuit openMs must be positive.");
    if (!Number.isSafeInteger(retryAfterCapMs) || retryAfterCapMs < 0) throw new TypeError("Circuit retryAfterCapMs must be non-negative.");
    if (typeof now !== "function") throw new TypeError("Circuit clock must be a function.");
    this.#failureThreshold = failureThreshold;
    this.#openMs = openMs;
    this.#retryAfterCapMs = retryAfterCapMs;
    this.#now = now;
  }

  #entry(key) {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { key, state: "closed", failures: 0, openedUntil: 0, probeTaskId: undefined, generation: 0 };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #refresh(entry, at) {
    if (entry.state === "open" && at >= entry.openedUntil) {
      entry.state = "half_open";
      entry.probeTaskId = undefined;
    }
    return entry;
  }

  peek({ route, host, at = this.#now() } = {}) {
    const entries = scopeKeys(route, host).map((key) => this.#refresh(this.#entry(key), at));
    const unavailable = entries.find((entry) => entry.state === "open" || (entry.state === "half_open" && entry.probeTaskId));
    return immutableSnapshot({
      available: !unavailable,
      reason: unavailable ? (unavailable.state === "open" ? "circuit_open" : "half_open_probe_in_flight") : undefined,
      scopes: entries.map(({ key, state, failures, openedUntil, generation }) => ({ key, state, failures, openedUntil, generation })),
    });
  }

  acquire({ route, host, taskId, at = this.#now() } = {}) {
    if (typeof taskId !== "string" || !taskId.trim()) throw new TypeError("Circuit taskId must be a non-empty string.");
    const entries = scopeKeys(route, host).map((key) => this.#refresh(this.#entry(key), at));
    const denied = entries.find((entry) => entry.state === "open" || (entry.state === "half_open" && entry.probeTaskId !== undefined));
    if (denied) {
      return immutableSnapshot({
        allowed: false,
        reason: denied.state === "open" ? "circuit_open" : "half_open_probe_in_flight",
        scope: denied.key,
        retryAt: denied.state === "open" ? denied.openedUntil : undefined,
      });
    }
    const probeScopes = [];
    for (const entry of entries) {
      if (entry.state === "half_open") {
        entry.probeTaskId = taskId;
        probeScopes.push(entry.key);
      }
    }
    return immutableSnapshot({ allowed: true, probe: probeScopes.length > 0, probeScopes });
  }

  recordFailure({ route, host, taskId, failure, at = this.#now(), forceOpen = false } = {}) {
    const normalized = failure?.failureClass ? failure : normalizeEngineeringFailure(failure, { now: at, dispatched: true });
    if (!normalized.capacityFailure) return immutableSnapshot({ recorded: false, reason: "not_capacity" });
    const keys = scopeKeys(route, host);
    const cooldownMs = Math.min(this.#retryAfterCapMs, normalized.retryAfterMs ?? this.#openMs);
    const states = [];
    for (const key of keys) {
      const entry = this.#refresh(this.#entry(key), at);
      if (entry.state === "half_open" && entry.probeTaskId && taskId && entry.probeTaskId !== taskId) {
        states.push({ key, state: entry.state, ignored: true });
        continue;
      }
      entry.failures += 1;
      const shouldOpen = forceOpen || normalized.failureClass === "RATE_LIMIT" || entry.state === "half_open" || entry.failures >= this.#failureThreshold;
      if (shouldOpen) {
        entry.state = "open";
        entry.openedUntil = at + Math.max(1, cooldownMs);
        entry.probeTaskId = undefined;
        entry.generation += 1;
      }
      states.push({ key, state: entry.state, failures: entry.failures, openedUntil: entry.openedUntil, generation: entry.generation });
    }
    return immutableSnapshot({ recorded: true, states });
  }

  recordSuccess({ route, host, taskId, at = this.#now() } = {}) {
    const states = [];
    for (const key of scopeKeys(route, host)) {
      const entry = this.#refresh(this.#entry(key), at);
      if (entry.state === "open") {
        states.push({ key, state: entry.state, ignored: true });
        continue;
      }
      if (entry.state === "half_open" && entry.probeTaskId !== taskId) {
        states.push({ key, state: entry.state, ignored: true });
        continue;
      }
      entry.state = "closed";
      entry.failures = 0;
      entry.openedUntil = 0;
      entry.probeTaskId = undefined;
      states.push({ key, state: entry.state, failures: 0, generation: entry.generation });
    }
    return immutableSnapshot({ recorded: true, states });
  }

  snapshot(at = this.#now()) {
    return immutableSnapshot([...this.#entries.values()]
      .map((entry) => this.#refresh(entry, at))
      .map(({ key, state, failures, openedUntil, probeTaskId, generation }) => ({
        key, state, failures, openedUntil, probeInFlight: probeTaskId !== undefined, generation,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)));
  }
}
