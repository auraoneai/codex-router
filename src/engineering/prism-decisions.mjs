import { randomUUID } from "node:crypto";

const GATEWAYS = new Set(["typesafe", "vercel", "openrouter"]);
const QUESTION_TYPES = new Set(["noul", "choice", "score"]);
const MAX_STATE_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_000_000;
const PROBABILITY_EPSILON = 1e-6;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new TypeError(`${name} contains unsupported field ${unexpected[0]}.`);
}

function text(value, name, max = 8_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${max} characters.`);
  }
  return value;
}

function headerText(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = text(value, name, 256);
  if (/[^\x20-\x7e]/.test(normalized)) throw new TypeError(`${name} contains invalid header characters.`);
  return normalized;
}

function finite(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a finite number in [${min}, ${max}].`);
  }
  return value;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}].`);
  }
  return value;
}

function probability(value, name) {
  return finite(value, name, { min: 0, max: 1 });
}

function assertJsonValue(value, name, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${name} contains a non-finite number.`);
    return;
  }
  if (!value || typeof value !== "object") throw new TypeError(`${name} contains a non-JSON value.`);
  if (seen.has(value)) throw new TypeError(`${name} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${name}.${index}`, seen));
  } else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError(`${name} contains a non-plain object.`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!key.trim()) throw new TypeError(`${name} contains a blank key.`);
      assertJsonValue(item, `${name}.${key}`, seen);
    }
  }
  seen.delete(value);
}

async function readBoundedResponse(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new PrismDecisionError("Prism decision response exceeded the client bound.", {
      code: "response_too_large", status: response.status,
    });
  }
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value) > maximumBytes) throw new PrismDecisionError(
      "Prism decision response exceeded the client bound.",
      { code: "response_too_large", status: response.status },
    );
    return value;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new PrismDecisionError("Prism decision response exceeded the client bound.", {
        code: "response_too_large", status: response.status,
      });
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function validateQuestion(id, question) {
  object(question, `questions.${id}`);
  if (!QUESTION_TYPES.has(question.type)) throw new TypeError(`questions.${id}.type is unsupported.`);
  exactKeys(
    question,
    question.type === "choice"
      ? ["type", "question", "options", "criteria"]
      : question.type === "score"
        ? ["type", "question", "criteria", "min_score", "max_score"]
        : ["type", "question", "criteria"],
    `questions.${id}`,
  );
  text(question.question, `questions.${id}.question`);
  if (question.type === "noul") {
    if (question.criteria !== undefined) {
      object(question.criteria, `questions.${id}.criteria`);
      const keys = Object.keys(question.criteria).sort();
      if (keys.join(",") !== "false,true") {
        throw new TypeError(`questions.${id}.criteria must contain exactly true and false.`);
      }
      for (const key of keys) text(question.criteria[key], `questions.${id}.criteria.${key}`, 512);
    }
    return;
  }
  if (question.type === "choice") {
    if (!Array.isArray(question.options) || question.options.length < 1 || question.options.length > 255) {
      throw new TypeError(`questions.${id}.options must contain 1-255 entries.`);
    }
    question.options.forEach((option, index) => text(option, `questions.${id}.options.${index}`, 512));
    if (new Set(question.options).size !== question.options.length) {
      throw new TypeError(`questions.${id}.options must be unique.`);
    }
    if (question.criteria !== undefined) {
      object(question.criteria, `questions.${id}.criteria`);
      for (const [key, value] of Object.entries(question.criteria)) {
        if (!question.options.includes(key)) throw new TypeError(`questions.${id}.criteria contains unknown option ${key}.`);
        text(value, `questions.${id}.criteria.${key}`, 512);
      }
    }
    return;
  }
  if (!Array.isArray(question.criteria) || question.criteria.length < 1 || question.criteria.length > 64) {
    throw new TypeError(`questions.${id}.criteria must contain 1-64 score levels.`);
  }
  question.criteria.forEach((level, index) => text(level, `questions.${id}.criteria.${index}`, 512));
  if (question.min_score !== undefined) finite(question.min_score, `questions.${id}.min_score`);
  if (question.max_score !== undefined) finite(question.max_score, `questions.${id}.max_score`);
  if (question.min_score !== undefined && question.max_score !== undefined &&
      question.min_score > question.max_score) {
    throw new TypeError(`questions.${id}.min_score must not exceed max_score.`);
  }
}

export function validateDecisionRequest(input) {
  object(input, "decision request");
  exactKeys(input, ["provider", "model", "state", "questions", "request_id"], "decision request");
  const provider = input.provider ?? "typesafe";
  if (provider !== "typesafe") throw new TypeError("Prism decisions support only logical provider typesafe.");
  const model = input.model ?? "jev-latest";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model)) throw new TypeError("decision model is invalid.");
  object(input.state, "state");
  if (Object.keys(input.state).length === 0) throw new TypeError("state must not be empty.");
  assertJsonValue(input.state, "state");
  let encodedState;
  try {
    encodedState = JSON.stringify(input.state);
  } catch {
    throw new TypeError("state must be JSON-serializable.");
  }
  if (encodedState === undefined) throw new TypeError("state must be JSON-serializable.");
  if (Buffer.byteLength(encodedState) > MAX_STATE_BYTES) {
    throw new TypeError(`state exceeds ${MAX_STATE_BYTES} bytes.`);
  }
  object(input.questions, "questions");
  const entries = Object.entries(input.questions);
  if (entries.length < 1 || entries.length > 64) throw new TypeError("questions must contain 1-64 entries.");
  for (const [id, question] of entries) {
    text(id, "question id", 128);
    validateQuestion(id, question);
  }
  const requestId = input.request_id || `eng-${randomUUID()}`;
  text(requestId, "request_id", 128);
  return structuredClone({
    provider,
    model,
    state: JSON.parse(encodedState),
    questions: input.questions,
    request_id: requestId,
  });
}

function validateAttempt(attempt, index) {
  object(attempt, `attempts.${index}`);
  if (!GATEWAYS.has(attempt.gateway)) throw new TypeError(`attempts.${index}.gateway is unsupported.`);
  text(attempt.model, `attempts.${index}.model`, 64);
  integer(attempt.ordinal, `attempts.${index}.ordinal`, { min: 1, max: 16 });
  text(attempt.kind, `attempts.${index}.kind`, 64);
  text(attempt.code, `attempts.${index}.code`, 64);
  integer(attempt.http_status, `attempts.${index}.http_status`, { max: 599 });
  if (!["pre_dispatch", "dispatched", "ambiguous"].includes(attempt.dispatch_state)) {
    throw new TypeError(`attempts.${index}.dispatch_state is unsupported.`);
  }
  if (!["SUCCEEDED", "FAILED", "UNKNOWN"].includes(attempt.outcome)) {
    throw new TypeError(`attempts.${index}.outcome is unsupported.`);
  }
  integer(attempt.latency_ms, `attempts.${index}.latency_ms`);
  if (attempt.retry_after_ms !== undefined && attempt.retry_after_ms !== null) {
    integer(attempt.retry_after_ms, `attempts.${index}.retry_after_ms`);
  }
  return structuredClone(attempt);
}

function validateAnswer(id, question, answer) {
  object(answer, `answers.${id}`);
  if (answer.type !== question.type) throw new TypeError(`answers.${id}.type does not match its question.`);
  if (question.type === "noul") {
    probability(answer.probability, `answers.${id}.probability`);
    return { type: "noul", probability: answer.probability };
  }
  if (question.type === "choice") {
    if (!question.options.includes(answer.selected)) throw new TypeError(`answers.${id}.selected is not a declared option.`);
    object(answer.probabilities, `answers.${id}.probabilities`);
    const keys = Object.keys(answer.probabilities).sort();
    if (keys.join("\0") !== [...question.options].sort().join("\0")) {
      throw new TypeError(`answers.${id}.probability keys do not match the options.`);
    }
    let sum = 0;
    for (const option of keys) sum += probability(answer.probabilities[option], `answers.${id}.probabilities.${option}`);
    if (Math.abs(sum - 1) > PROBABILITY_EPSILON) throw new TypeError(`answers.${id}.probabilities must sum to 1.`);
    probability(answer.confidence, `answers.${id}.confidence`);
    return structuredClone(answer);
  }
  const score = finite(answer.score, `answers.${id}.score`);
  if (question.min_score !== undefined && score < question.min_score) throw new TypeError(`answers.${id}.score is below its minimum.`);
  if (question.max_score !== undefined && score > question.max_score) throw new TypeError(`answers.${id}.score is above its maximum.`);
  probability(answer.confidence, `answers.${id}.confidence`);
  if (answer.probabilities !== undefined && answer.probabilities !== null) {
    object(answer.probabilities, `answers.${id}.probabilities`);
    for (const [key, value] of Object.entries(answer.probabilities)) {
      text(key, `answers.${id}.probability key`, 512);
      probability(value, `answers.${id}.probabilities.${key}`);
    }
  }
  return structuredClone(answer);
}

export function validateDecisionResponse(payload, request) {
  object(payload, "decision response");
  exactKeys(
    payload,
    ["request_id", "provider", "model", "answers", "usage", "latency_ms", "serving_gateway", "attempts"],
    "decision response",
  );
  text(payload.request_id, "response.request_id", 128);
  if (payload.request_id !== request.request_id) throw new TypeError("decision response request_id does not match the request.");
  if (payload.provider !== "typesafe") throw new TypeError("decision response provider is unsupported.");
  text(payload.model, "response.model", 64);
  object(payload.answers, "response.answers");
  const expectedIds = Object.keys(request.questions).sort();
  if (Object.keys(payload.answers).sort().join("\0") !== expectedIds.join("\0")) {
    throw new TypeError("decision response answer ids do not match the request.");
  }
  const answers = Object.fromEntries(expectedIds.map((id) => [
    id,
    validateAnswer(id, request.questions[id], payload.answers[id]),
  ]));
  object(payload.usage, "response.usage");
  const usage = {
    input_tokens: integer(payload.usage.input_tokens, "response.usage.input_tokens"),
    output_tokens: integer(payload.usage.output_tokens, "response.usage.output_tokens"),
  };
  integer(payload.latency_ms, "response.latency_ms");
  if (!GATEWAYS.has(payload.serving_gateway)) {
    throw new TypeError("decision response is missing valid serving_gateway provenance.");
  }
  if (!Array.isArray(payload.attempts) || payload.attempts.length < 1 || payload.attempts.length > 16) {
    throw new TypeError("decision response must contain 1-16 provenance attempts.");
  }
  const attempts = payload.attempts.map(validateAttempt);
  attempts.forEach((attempt, index) => {
    if (attempt.ordinal !== index + 1) throw new TypeError("decision response attempt ordinals are not ordered.");
  });
  if (attempts.at(-1).gateway !== payload.serving_gateway || attempts.at(-1).outcome !== "SUCCEEDED") {
    throw new TypeError("decision response serving_gateway must match the successful final attempt.");
  }
  return Object.freeze({
    requestId: payload.request_id,
    provider: payload.provider,
    model: payload.model,
    answers: Object.freeze(answers),
    usage: Object.freeze(usage),
    latencyMs: payload.latency_ms,
    provenance: Object.freeze({ servingGateway: payload.serving_gateway, attempts: Object.freeze(attempts) }),
  });
}

export class PrismDecisionError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "PrismDecisionError";
    Object.assign(this, fields);
  }
}

export class PrismDecisionsClient {
  constructor({
    baseUrl = "https://prism.auraone.ai",
    apiKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = 1_500,
    client = "codex-router-engineering",
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required.");
    if (typeof apiKey !== "string" || !apiKey) throw new TypeError("A Prism API key is required.");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive.");
    this.url = new URL("/v1/decisions", baseUrl).toString();
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.client = client;
  }

  async decide(input, { signal, timeoutMs = this.timeoutMs, attribution = {} } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive.");
    const request = validateDecisionRequest(input);
    const session = headerText(attribution.session, "attribution.session");
    const parentSession = headerText(attribution.parentSession, "attribution.parentSession");
    const agentId = headerText(attribution.agentId, "attribution.agentId");
    const repo = headerText(attribution.repo, "attribution.repo");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let deadlineExpired = false;
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(new Error("deadline exceeded"));
    }, timeoutMs);
    let response;
    let raw;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "x-prism-client": this.client,
          "x-prism-job-type": "engineering-decision",
          ...(session ? { "x-prism-session": session } : {}),
          ...(parentSession ? { "x-prism-parent-session": parentSession } : {}),
          ...(agentId ? { "x-prism-agent-id": agentId } : {}),
          ...(repo ? { "x-prism-repo": repo } : {}),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      raw = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof PrismDecisionError) throw error;
      const cancelled = signal?.aborted && !deadlineExpired;
      throw new PrismDecisionError(
        deadlineExpired
          ? `Prism decision deadline exceeded after ${timeoutMs}ms.`
          : cancelled ? "Prism decision request was cancelled." : "Prism decision transport failed.", {
        code: deadlineExpired ? "deadline_exceeded" : cancelled ? "cancelled" : "transport_error",
        requestId: request.request_id,
        retryable: !cancelled,
        outcome: cancelled ? "CANCELLED" : "UNKNOWN",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
    }
    let payload;
    try { payload = JSON.parse(raw); } catch {
      throw new PrismDecisionError("Prism decision response was not valid JSON.", {
        code: "invalid_response", status: response.status, requestId: request.request_id,
      });
    }
    if (!response.ok) {
      const detail = payload?.error && typeof payload.error === "object" ? payload.error : {};
      try {
        object(payload, "decision error response");
        exactKeys(payload, ["error", "request_id", "attempts"], "decision error response");
        object(detail, "decision error response.error");
        exactKeys(
          detail,
          ["message", "type", "code", "retryable", "dispatch_state", "outcome"],
          "decision error response.error",
        );
        text(payload.request_id, "decision error response.request_id", 128);
        if (payload.request_id !== request.request_id) throw new TypeError("decision error request_id does not match the request.");
        text(detail.code, "decision error code", 64);
        if (detail.type !== "decision_provider_error") throw new TypeError("decision error type is unsupported.");
        if (typeof detail.retryable !== "boolean") throw new TypeError("decision error retryable must be boolean.");
        if (!["pre_dispatch", "dispatched", "ambiguous"].includes(detail.dispatch_state)) {
          throw new TypeError("decision error dispatch_state is unsupported.");
        }
        if (!["FAILED", "UNKNOWN"].includes(detail.outcome)) throw new TypeError("decision error outcome is unsupported.");
        if ((detail.dispatch_state === "ambiguous") !== (detail.outcome === "UNKNOWN")) {
          throw new TypeError("decision error ambiguity fields are inconsistent.");
        }
      } catch (cause) {
        throw new PrismDecisionError("Prism decision error contract failed validation.", {
          code: "invalid_response", status: response.status, requestId: request.request_id, cause,
        });
      }
      let attempts = [];
      try {
        attempts = Array.isArray(payload?.attempts) ? payload.attempts.map(validateAttempt) : [];
        attempts.forEach((attempt, index) => {
          if (attempt.ordinal !== index + 1) throw new TypeError("decision error attempt ordinals are not ordered.");
        });
        if (attempts.some((attempt) => attempt.dispatch_state === "ambiguous" || attempt.outcome === "UNKNOWN") &&
            (detail.dispatch_state !== "ambiguous" || detail.outcome !== "UNKNOWN")) {
          throw new TypeError("decision error cannot hide an ambiguous provider attempt.");
        }
      } catch (cause) {
        throw new PrismDecisionError("Prism decision error provenance failed validation.", {
          code: "invalid_response", status: response.status, requestId: request.request_id, cause,
        });
      }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      throw new PrismDecisionError("Prism decision request failed.", {
        code: typeof detail.code === "string" ? detail.code : "decision_error",
        status: response.status,
        requestId: payload?.request_id || request.request_id,
        retryable: detail.retryable === true,
        dispatchState: detail.dispatch_state,
        outcome: detail.outcome,
        retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? Math.round(retryAfterSeconds * 1_000)
          : undefined,
        attempts,
      });
    }
    try {
      return validateDecisionResponse(payload, request);
    } catch (error) {
      throw new PrismDecisionError(`Prism decision response failed validation: ${error.message}`, {
        code: "invalid_response", status: response.status, requestId: request.request_id, cause: error,
      });
    }
  }
}
