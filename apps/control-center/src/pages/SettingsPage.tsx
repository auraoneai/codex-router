import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Check, ChevronDown, ChevronUp, Eye, LogIn, Moon, Pencil, Plus, RefreshCw, RotateCcw, Server, ShieldCheck, Sun, Trash2, UserRound, Wrench, X } from "lucide-react";
import { Badge, Button, Dialog, InlineNotice, PageHeader, SectionHeading, Toggle } from "../components";
import { compactNumber } from "../lib";
import { LANGUAGE_OPTIONS, type LanguageId, type Translate } from "../i18n";
import type {
  ChatGptAccountPool,
  ClaudeAccountPool,
  ChatGptSessionStatus,
  ChatGptSubscriptionAccount,
  ClaudeSubscriptionAccount,
  DoctorSnapshot,
  EngineeringPolicyCandidate,
  EngineeringPolicySnapshot,
  PresenceSnapshot,
  RouterControlApi,
  RouterHealth,
  RouterModel,
  RouterTarget,
  VisionEngine,
} from "../types";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";

// Mirrors RETENTION_MIN/MAX/DEFAULT_TTL_DAYS in src/tool-result-retention.mjs.
// `0` is not "no retention" -- it is the stored answer meaning "keep the
// archived originals until I say otherwise", so it gets its own option rather
// than being folded in with the default.
const RETENTION_DEFAULT_TTL_DAYS = 7;
const RETENTION_CHOICES = [1, 3, 7, 14, 30, 90];

type AccountOverlay =
  | { kind: "add"; clientId: string; account: ChatGptSubscriptionAccount }
  | { kind: "remove"; accountId: string };

function isOptimisticAccountId(id: string): boolean {
  return id.startsWith("pending:");
}

function optimisticAccountPlaceholder(label: string, clientId: string): ChatGptSubscriptionAccount {
  return {
    id: clientId,
    state: "active",
    paused: false,
    priority: 50,
    label: label || "New account",
    subscription: { status: "pending", authenticated: false, usable: false, expired: false },
    turns: 0,
    requests: 0,
  };
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatTimeUntil(timestampMs?: number | null): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return "";
  const diff = timestampMs - Date.now();
  if (diff <= 0) return "resets now";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `resets in ${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `resets in ${days}d ${remainingHours}h`;
}

function roleLabel(role: string): string {
  return role.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function candidateLabel(candidate: EngineeringPolicyCandidate, t: Translate, models: ReadonlyMap<string, RouterModel> = new Map()): string {
  const modelDefault = models.get(candidate.model)?.defaultEffort;
  const effort = candidate.effort && candidate.effort !== "default"
    ? candidate.effort
    : modelDefault
      ? `${modelDefault} (${t("settings.engineering.effort.default")})`
      : t("settings.engineering.effort.default");
  return `${candidate.model} · ${effort}`;
}

type EngineeringEditor =
  | { kind: "lead"; model: string; effort: string }
  | { kind: "role"; role: string; candidates: EngineeringPolicyCandidate[]; optionalCandidates: EngineeringPolicyCandidate[] };

const ENGINEERING_EFFORTS = ["default", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function engineeringUsageLabel(engineering: EngineeringPolicySnapshot | undefined, t: Translate): {
  tone: "neutral" | "success" | "warning";
  label: string;
  detail: string;
} {
  const usage = engineering?.usage;
  const total = usage?.fields?.totalTokens;
  if (!usage || !total || usage.requests < 1) {
    return {
      tone: "neutral",
      label: t("settings.engineering.usage.unknown"),
      detail: t("settings.engineering.usage.none"),
    };
  }
  const measured = Number.isFinite(total.measured) ? total.measured : 0;
  const estimated = Number.isFinite(total.estimated) ? total.estimated : 0;
  const unknown = Number.isFinite(total.unknown) ? total.unknown : usage.requests;
  if (unknown > 0) {
    return {
      tone: "warning",
      label: t("settings.engineering.usage.unknown"),
      detail: t("settings.engineering.usage.detail", {
        tokens: compactNumber(measured + estimated),
        requests: compactNumber(usage.requests),
        unknown: compactNumber(unknown),
      }),
    };
  }
  return {
    tone: estimated > 0 ? "neutral" : "success",
    label: t(estimated > 0
      ? "settings.engineering.usage.estimated"
      : "settings.engineering.usage.measured"),
    detail: t("settings.engineering.usage.detail", {
      tokens: compactNumber(measured + estimated),
      requests: compactNumber(usage.requests),
      unknown: 0,
    }),
  };
}

export function SettingsPage({ target, engineering, models = [], health, presence, chatgptSession, accountPool, accountPoolError, claudeAccountPool, claudeAccountPoolError, api, theme, onTheme, language, onLanguage, t, refreshing, onRefresh, runAction }: {
  target?: RouterTarget;
  engineering?: EngineeringPolicySnapshot;
  models?: RouterModel[];
  health?: RouterHealth;
  presence?: PresenceSnapshot;
  chatgptSession?: ChatGptSessionStatus;
  accountPool?: ChatGptAccountPool;
  accountPoolError?: string;
  claudeAccountPool?: ClaudeAccountPool;
  claudeAccountPoolError?: string;
  api?: RouterControlApi;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  language: LanguageId;
  onLanguage: (language: LanguageId) => void;
  t: Translate;
  refreshing: boolean;
  onRefresh: () => Promise<unknown> | void;
  runAction: RunAction;
}) {
  const [confirmTrayDisable, setConfirmTrayDisable] = useState(false);
  const [confirmSessionSharing, setConfirmSessionSharing] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [engineeringMutationPending, setEngineeringMutationPending] = useState(false);
  const [engineeringEditor, setEngineeringEditor] = useState<EngineeringEditor | null>(null);
  const [repairReport, setRepairReport] = useState<DoctorSnapshot | null>(null);
  const [newAccountLabel, setNewAccountLabel] = useState("");
  const [newClaudeAccountLabel, setNewClaudeAccountLabel] = useState("");
  const [removeAccountId, setRemoveAccountId] = useState<string | null>(null);
  const [removeClaudeAccountId, setRemoveClaudeAccountId] = useState<string | null>(null);
  const [loginPendingId, setLoginPendingId] = useState<string | null>(null);
  const [loginRetryingId, setLoginRetryingId] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [claudeAccountError, setClaudeAccountError] = useState<string | null>(null);
  const [accountOverlays, setAccountOverlays] = useState<AccountOverlay[]>([]);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const engineeringModels = useMemo(() => {
    const bySlug = new Map(models.map((model) => [model.slug, model]));
    for (const role of Object.values(engineering?.roles || {})) {
      for (const candidate of [...(role.candidates || []), ...(role.optionalCandidates || [])]) {
        if (!bySlug.has(candidate.model)) {
          bySlug.set(candidate.model, {
            slug: candidate.model,
            displayName: candidate.model,
            provider: candidate.model.includes("/") ? candidate.model.split("/")[0] : "openai",
            enabled: true,
            visible: true,
          });
        }
      }
    }
    if (engineering?.lead && !bySlug.has(engineering.lead.model)) {
      bySlug.set(engineering.lead.model, {
        slug: engineering.lead.model,
        displayName: engineering.lead.model,
        provider: "openai",
        enabled: true,
        visible: true,
      });
    }
    return bySlug;
  }, [engineering, models]);
  const currentEngineeringRoutes = useMemo(() => new Set(
    Object.values(engineering?.roles || {}).flatMap((role) => (
      [...(role.candidates || []), ...(role.optionalCandidates || [])].map(({ model }) => model)
    )),
  ), [engineering]);
  const engineeringModelOptions = useMemo(
    () => [...engineeringModels.values()]
      .filter((model) => currentEngineeringRoutes.has(model.slug) || (
        model.enabled && model.available !== false && model.multiAgentVersion === "v2"
      ))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [currentEngineeringRoutes, engineeringModels],
  );
  const engineeringLeadOptions = useMemo(() => {
    const current = engineering?.lead?.model;
    return [...engineeringModels.values()]
      .filter((model) => model.slug === current || (model.native === true && model.enabled && model.available !== false))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [engineering, engineeringModels]);
  const candidateEfforts = (model: string, current: string | undefined) => {
    const advertised = engineeringModels.get(model)?.reasoningLevels || [];
    const supported = advertised.length ? advertised : ENGINEERING_EFFORTS.slice(1);
    return [...new Set(["default", ...supported, ...(current ? [current] : [])])];
  };
  const editCandidate = (list: "candidates" | "optionalCandidates", index: number, patch: Partial<EngineeringPolicyCandidate>) => {
    setEngineeringEditor((current) => {
      if (!current || current.kind !== "role") return current;
      const next = current[list].map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, ...patch } : candidate);
      return { ...current, [list]: next };
    });
  };
  const moveCandidate = (list: "candidates" | "optionalCandidates", index: number, direction: -1 | 1) => {
    setEngineeringEditor((current) => {
      if (!current || current.kind !== "role") return current;
      const target = index + direction;
      if (target < 0 || target >= current[list].length) return current;
      const next = [...current[list]];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, [list]: next };
    });
  };
  const removeCandidate = (list: "candidates" | "optionalCandidates", index: number) => {
    setEngineeringEditor((current) => current?.kind === "role"
      ? { ...current, [list]: current[list].filter((_, candidateIndex) => candidateIndex !== index) }
      : current);
  };
  const addCandidate = (list: "candidates" | "optionalCandidates") => {
    setEngineeringEditor((current) => {
      if (!current || current.kind !== "role") return current;
      const used = new Set([...current.candidates, ...current.optionalCandidates].map(({ model }) => model));
      const model = engineeringModelOptions.find((option) => !used.has(option.slug))?.slug;
      if (!model) return current;
      return { ...current, [list]: [...current[list], { model, effort: "default" }] };
    });
  };
  const [trayCapability, setTrayCapability] = useState<{ supported?: boolean; why?: string }>();
  useEffect(() => {
    let active = true;
    if (!api) {
      setTrayCapability(undefined);
      return () => { active = false; };
    }
    void api.controlTray("status").then((result) => {
      if (!active) return;
      const status = (result as { status?: { supported?: boolean; why?: string } } | undefined)?.status;
      setTrayCapability(status);
    }).catch(() => {
      if (active) setTrayCapability(undefined);
    });
    return () => { active = false; };
  }, [api, refreshing]);
  const observedLoginAttempt = loginPendingId
    ? accountPool?.loginAttempts?.[loginPendingId]
    : undefined;
  const loginAttempt = loginPendingId === loginRetryingId && observedLoginAttempt?.status === "failed"
    ? undefined
    : observedLoginAttempt;
  const loginPendingUsable = loginPendingId
    ? accountPool?.accounts?.[loginPendingId]?.subscription?.usable === true && !loginAttempt
    : false;
  useEffect(() => {
    if (!loginPendingId) return;
    if (loginPendingId === loginRetryingId && observedLoginAttempt?.status === "pending") {
      setLoginRetryingId(null);
    }
    if (loginPendingUsable) {
      setLoginPendingId(null);
      setLoginRetryingId(null);
      setLoginError(null);
      return;
    }
    if (loginAttempt?.status === "failed") {
      setLoginPendingId(null);
      setLoginRetryingId(null);
      setLoginError(loginAttempt.error || "Codex login did not complete. Try again.");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refreshRef.current();
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_500);
    };
    timer = window.setTimeout(() => void poll(), 1_500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loginAttempt?.error, loginAttempt?.status, loginPendingId, loginPendingUsable, loginRetryingId, observedLoginAttempt?.status]);
  const trayControlsUnavailable = trayCapability?.supported === false;
  const repairFailures = useMemo(
    () => (repairReport?.checks ?? []).filter((check) => check.status === "fail"),
    [repairReport],
  );
  const sessionSharingEnabled = chatgptSession?.sharing === "enabled";
  const sessionLoginLabel = chatgptSession?.session === "usable"
    ? (typeof chatgptSession.expiresInHours === "number"
      ? t("settings.chatgptSession.status.loginUsableHours", { hours: chatgptSession.expiresInHours })
      : t("settings.chatgptSession.status.loginUsable"))
    : chatgptSession?.session === "expired"
      ? t("settings.chatgptSession.status.loginExpired")
      : chatgptSession?.present
        ? t("settings.chatgptSession.status.loginUnavailableDetected")
        : t("settings.chatgptSession.status.loginUnavailableLogin");
  const sessionSharingLabel = chatgptSession
    ? `${t(sessionSharingEnabled
      ? "settings.chatgptSession.status.sharingEnabled"
      : "settings.chatgptSession.status.sharingDisabled")} · ${sessionLoginLabel}`
    : t("settings.chatgptSession.status.unavailable");
  // Revoked records are cleanup tombstones from older router versions. They
  // are not usable accounts and must never reappear as "Account 1/2" rows.
  // Keep paused records visible so a future resume control can explain them.
  // Add/remove overlays paint immediately; runAction's later refresh replaces
  // them with authoritative pool state and clears the matching overlays.
  useEffect(() => {
    if (accountPoolError || !accountPool) return;
    setAccountOverlays((current) => {
      if (!current.length) return current;
      const next = current.filter((entry) => {
        if (entry.kind === "add") {
          return !accountPool.accounts?.[entry.account.id];
        }
        const remaining = accountPool.accounts?.[entry.accountId];
        return Boolean(remaining && remaining.state !== "revoked");
      });
      return next.length === current.length ? current : next;
    });
  }, [accountPool, accountPoolError]);
  const subscriptionAccounts = useMemo(() => {
    const base = Object.values(accountPoolError ? {} : accountPool?.accounts || {})
      .filter((account) => account.state !== "revoked");
    const removedIds = new Set(
      accountOverlays
        .filter((entry): entry is Extract<AccountOverlay, { kind: "remove" }> => entry.kind === "remove")
        .map((entry) => entry.accountId),
    );
    const visible = base.filter((account) => !removedIds.has(account.id));
    const visibleIds = new Set(visible.map((account) => account.id));
    const pendingAdds = accountOverlays
      .filter((entry): entry is Extract<AccountOverlay, { kind: "add" }> => entry.kind === "add")
      .map((entry) => entry.account)
      .filter((account) => !visibleIds.has(account.id));
    return [...visible, ...pendingAdds];
  }, [accountOverlays, accountPool, accountPoolError]);
  const usableSubscriptionAccounts = subscriptionAccounts.filter((account) => account.state === "active" && account.subscription?.usable === true);
  const activeAccountId = accountPool?.profile?.active;
  const accountSelection = accountPool?.profile?.desired || activeAccountId || usableSubscriptionAccounts[0]?.id || "";

  const addSubscriptionAccount = async () => {
    if (!api || accountPoolError) return;
    const label = newAccountLabel.trim();
    const clientId = `pending:${crypto.randomUUID()}`;
    setAccountOverlays((current) => [
      ...current,
      { kind: "add", clientId, account: optimisticAccountPlaceholder(label, clientId) },
    ]);
    setNewAccountLabel("");
    let saved = false;
    try {
      await runAction("Add ChatGPT subscription account", async () => {
        const result = await api.addChatGptSubscriptionAccount(label) as {
          account?: ChatGptSubscriptionAccount;
        };
        const created = result?.account;
        if (created?.id) {
          setAccountOverlays((current) => current.map((entry) => (
            entry.kind === "add" && entry.clientId === clientId
              ? { kind: "add", clientId, account: created }
              : entry
          )));
        } else {
          // The durable write succeeded but returned no row. Drop the
          // placeholder so refreshCore's authoritative pool is the only source.
          setAccountOverlays((current) => current.filter((entry) => !(
            entry.kind === "add" && entry.clientId === clientId
          )));
        }
        saved = true;
        return result;
      });
    } finally {
      if (!saved) {
        setAccountOverlays((current) => current.filter((entry) => !(
          entry.kind === "add" && entry.clientId === clientId
        )));
      }
    }
  };

  const removeSubscriptionAccount = async (accountId: string) => {
    if (!api || !accountId || loginPendingId === accountId) return;
    setRemoveAccountId(null);
    setAccountOverlays((current) => [...current, { kind: "remove", accountId }]);
    let saved = false;
    try {
      await runAction("Remove ChatGPT subscription account", async () => {
        await api.removeChatGptSubscriptionAccount(accountId);
        saved = true;
      });
    } finally {
      if (!saved) {
        setAccountOverlays((current) => current.filter((entry) => !(
          entry.kind === "remove" && entry.accountId === accountId
        )));
      }
    }
  };

  const claudeAccounts = useMemo(() => {
    return Object.values(claudeAccountPoolError ? {} : claudeAccountPool?.accounts || {})
      .filter((account) => account.state !== "revoked");
  }, [claudeAccountPool, claudeAccountPoolError]);

  const claudeAccountSelection = claudeAccountPool?.policy?.selectedAccountId;

  const addClaudeAccount = async () => {
    if (!api) return;
    setClaudeAccountError(null);
    try {
      await runAction("Add Claude account", async () => {
        await api.addClaudeSubscriptionAccount(newClaudeAccountLabel);
        setNewClaudeAccountLabel("");
      });
    } catch (err: any) {
      setClaudeAccountError(err?.message || "No valid Claude Code credentials found. Please run 'claude login' in your terminal first.");
    }
  };

  const removeClaudeAccount = async (accountId: string) => {
    if (!api || !accountId) return;
    setRemoveClaudeAccountId(null);
    await runAction("Remove Claude subscription account", async () => {
      await api.removeClaudeSubscriptionAccount(accountId);
    });
  };

  // Repair reinstalls and restarts the service, so it can outlast several
  // ordinary actions. `runAction` owns the toast and the refresh; the report
  // is kept here as well because runAction discards the resolved value and a
  // repair that finishes with checks still failing needs to say which ones.
  const runRepair = async () => {
    if (!api || repairing) return;
    setRepairing(true);
    setRepairReport(null);
    try {
      await runAction(t("settings.maintenance.fix"), async () => {
        const report = await api.repairInstall();
        setRepairReport(report);
        if (!report.ok) {
          const failed = report.checks?.find((check) => check.status === "fail");
          throw new Error(failed ? `${failed.name}: ${failed.detail || "check failed"}` : "Repair finished with failing checks.");
        }
        return report;
      });
    } finally {
      setRepairing(false);
    }
  };

  const aging = target?.modelSettings?.toolResultAging;
  const agingLocked = aging?.environmentOverride === true;
  const stats = aging?.stats;
  const hasSavings = typeof stats?.estimatedTokensSaved === "number" && stats.estimatedTokensSaved > 0;
  // `retentionTtlDays` is absent only when nobody has answered, which is a
  // different state from a stored 0. Keep them apart in the select.
  const ttlValue = aging?.retentionTtlDays === undefined ? "default" : String(aging.retentionTtlDays);
  const ttlChoices = aging?.retentionTtlDays !== undefined && aging.retentionTtlDays > 0
      && !RETENTION_CHOICES.includes(aging.retentionTtlDays)
    ? [...RETENTION_CHOICES, aging.retentionTtlDays].sort((left, right) => left - right)
    : RETENTION_CHOICES;

  const bridge = target?.modelSettings?.visionBridge;
  const engineeringKnownFresh = Boolean(
    engineering
    && engineering.fresh === true
    && engineering.degraded !== true
    && engineering.healthy !== false
    && Number.isSafeInteger(engineering.revision)
    && (engineering.revision ?? -1) >= 0,
  );
  const engineeringRoles = Object.entries(engineering?.roles || {});
  const engineeringUsage = engineeringUsageLabel(engineering, t);
  const toggleStates = useMemo(() => new Map([
    ["signed-routing", target?.signedRouting === true],
    ...(engineeringKnownFresh ? [["engineering", engineering?.enabled === true] as const] : []),
    ["tool-result-aging", aging?.enabled === true],
    ["native-tool-result-aging", aging?.nativeEnabled === true],
    ["vision-bridge", bridge?.enabled === true],
  ]), [aging?.enabled, aging?.nativeEnabled, bridge?.enabled, engineering?.enabled, engineeringKnownFresh, target?.signedRouting]);
  const optimisticToggles = useOptimisticValues(toggleStates, runAction);
  const toolResultAgingEnabled = optimisticToggles.value("tool-result-aging", aging?.enabled === true);
  // Same split the tray menu shows: the models the operator already pays for,
  // then the ones their ChatGPT plan covers. Which bill a choice lands on is
  // the only thing separating two otherwise identical engine names.
  const paidEngines = bridge?.paidEngines ?? [];
  const nativeEngines = bridge?.nativeEngines ?? [];
  const selectedEngine = bridge?.engine || "auto";
  const selectedEngineMeta = [...paidEngines, ...nativeEngines].find((engine) => engine.slug === selectedEngine);
  // A pinned engine can leave both lists -- a native model that dropped out of
  // the picker, a provider switched off. The tray keeps naming it; carry it as
  // its own entry so the select cannot silently fall back to its first option
  // and report an engine the router is not using.
  const unlistedEngine: VisionEngine | null = selectedEngine !== "auto" && selectedEngine !== "local" && !selectedEngineMeta
    ? { slug: selectedEngine, displayName: bridge?.resolvedEngineName || bridge?.resolvedEngine || selectedEngine }
    : null;
  const engineEfforts = selectedEngineMeta?.efforts?.length
    ? selectedEngineMeta.efforts
    : bridge?.availableEfforts ?? [];
  const selectedEffort = bridge?.effort || "default";
  // Same reason as the engine above: show the pinned level even when the
  // engine that declared it is no longer listed.
  const effortOptions = selectedEffort !== "default" && !engineEfforts.includes(selectedEffort)
    ? [...engineEfforts, selectedEffort]
    : engineEfforts;

  return (
    <>
      <PageHeader eyebrow={t("settings.eyebrow")} title={t("settings.title")} description={t("settings.description")} onRefresh={onRefresh} refreshing={refreshing} />
      <div className="settings-columns">
        <div className="page-stack">
          <section className="panel-section">
            <SectionHeading title={t("settings.engineering.title")} description={t("settings.engineering.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div>
                  <strong>{t("settings.engineering.toggle.title")}</strong>
                  <small>{engineeringKnownFresh
                    ? t("settings.engineering.toggle.detail")
                    : t("settings.engineering.unavailable")}</small>
                </div>
                {engineeringKnownFresh ? (
                  <Toggle
                    checked={optimisticToggles.value("engineering", engineering?.enabled === true)}
                    disabled={!api || engineeringMutationPending}
                    label={t("settings.engineering.toggle.title")}
                    onChange={(enabled) => {
                      if (!api || !Number.isSafeInteger(engineering?.revision)) return;
                      const revision = engineering!.revision as number;
                      setEngineeringMutationPending(true);
                      void optimisticToggles.mutate(
                        "engineering",
                        enabled,
                        enabled
                          ? t("settings.engineering.action.enable")
                          : t("settings.engineering.action.disable"),
                        () => api.setEngineeringEnabled(enabled, revision),
                      ).finally(() => setEngineeringMutationPending(false));
                    }}
                  />
                ) : (
                  <Badge tone={engineering?.degraded ? "danger" : "neutral"}>
                    {engineering?.degraded
                      ? t("settings.engineering.status.degraded")
                      : t("settings.engineering.status.unavailable")}
                  </Badge>
                )}
              </div>
              <div className="setting-row static-row">
                <div>
                  <strong>{t("settings.engineering.preset")}</strong>
                  <small>{engineeringKnownFresh && engineering?.revision !== null
                    ? t("settings.engineering.revision", { revision: engineering?.revision ?? 0 })
                    : t("settings.engineering.unavailable")}</small>
                </div>
                <Badge tone={engineering?.enabled && engineeringKnownFresh ? "success" : "neutral"}>
                  {engineeringKnownFresh
                    ? engineering?.activePreset || "—"
                    : "—"}
                </Badge>
              </div>
            </div>
            {engineering?.degraded ? (
              <InlineNotice tone="danger" title={t("settings.engineering.status.degraded")}>
                {t("settings.engineering.degraded")}
              </InlineNotice>
            ) : null}
            {engineeringKnownFresh && engineeringRoles.length ? (
              <>
                <SectionHeading title={t("settings.engineering.roles.title")} description={t("settings.engineering.roles.description")} />
                <div className="settings-list">
                  {engineering?.lead ? (
                    <div className="setting-row static-row">
                      {engineeringEditor?.kind === "lead" ? (
                        <div className="engineering-editor">
                          <strong>{t("settings.engineering.lead.native")}</strong>
                          <div className="engineering-route-editor">
                            <select aria-label="Lead model" value={engineeringEditor.model} onChange={(event) => setEngineeringEditor({ ...engineeringEditor, model: event.target.value })}>
                              {engineeringLeadOptions.map((model) => <option key={model.slug} value={model.slug}>{model.displayName} · {model.slug}</option>)}
                            </select>
                            <select aria-label="Lead effort" value={engineeringEditor.effort} onChange={(event) => setEngineeringEditor({ ...engineeringEditor, effort: event.target.value })}>
                              {candidateEfforts(engineeringEditor.model, engineeringEditor.effort).map((effort) => <option key={effort} value={effort}>{effort === "default" ? t("settings.engineering.effort.defaultOption") : effort}</option>)}
                            </select>
                          </div>
                          <small>{t("settings.engineering.effort.help")}</small>
                          <div className="engineering-editor-actions">
                            <Button variant="secondary" disabled={!api || engineeringMutationPending} onClick={() => setEngineeringEditor(null)}><X aria-hidden size={13} /> {t("common.cancel")}</Button>
                            <Button disabled={!api || engineeringMutationPending || engineering?.revision === null} onClick={() => {
                              if (!api || engineering?.revision === null || engineering?.revision === undefined || engineeringEditor.kind !== "lead") return;
                              setEngineeringMutationPending(true);
                              let saved = false;
                              void runAction(t("settings.engineering.action.save"), async () => {
                                const result = await api.setEngineeringLead(engineeringEditor.model, engineeringEditor.effort, engineering.revision as number);
                                saved = true;
                                return result;
                              }).finally(() => {
                                setEngineeringMutationPending(false);
                                if (saved) setEngineeringEditor(null);
                              });
                            }}>{t("common.save")}</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div>
                            <strong>{t("settings.engineering.lead.native")}</strong>
                            <small>{t("settings.engineering.lead.detail", {
                              route: candidateLabel(engineering.lead, t, engineeringModels),
                            })}</small>
                          </div>
                          <Button aria-label="Edit native Codex lead" variant="secondary" disabled={!api || engineeringMutationPending} onClick={() => setEngineeringEditor({ kind: "lead", model: engineering.lead!.model, effort: engineering.lead!.effort })}><Pencil aria-hidden size={13} /> {t("common.edit")}</Button>
                        </>
                      )}
                    </div>
                  ) : null}
                  {engineeringRoles.map(([roleName, role]) => {
                    const candidates = (role.candidates || []).filter((candidate) => candidate.disabled !== true);
                    const optionalCandidates = (role.optionalCandidates || []).filter((candidate) => candidate.disabled !== true);
                    const [primary, ...fallbacks] = candidates;
                    const editing = engineeringEditor?.kind === "role" && engineeringEditor.role === roleName
                      ? engineeringEditor
                      : undefined;
                    return (
                      <div className="setting-row static-row" key={roleName}>
                        {editing ? (
                          <div className="engineering-editor">
                            <strong>{roleLabel(roleName)}</strong>
                            <small>{t("settings.engineering.editor.ordered")}</small>
                            {editing.candidates.map((candidate, index) => (
                              <div className="engineering-route-editor" key={`candidate-${index}`}>
                                <span>{index === 0 ? t("settings.engineering.editor.primary") : t("settings.engineering.editor.fallback", { index })}</span>
                                <select aria-label={`${roleLabel(roleName)} ${index === 0 ? "primary" : `fallback ${index}`} model`} value={candidate.model} onChange={(event) => editCandidate("candidates", index, { model: event.target.value })}>
                                  {engineeringModelOptions.map((model) => <option key={model.slug} value={model.slug}>{model.displayName} · {model.slug}</option>)}
                                </select>
                                <select aria-label={`${roleLabel(roleName)} ${index === 0 ? "primary" : `fallback ${index}`} effort`} value={candidate.effort || "default"} onChange={(event) => editCandidate("candidates", index, { effort: event.target.value })}>
                                  {candidateEfforts(candidate.model, candidate.effort).map((effort) => <option key={effort} value={effort}>{effort === "default" ? t("settings.engineering.effort.defaultOption") : effort}</option>)}
                                </select>
                                <button type="button" className="engineering-icon-button" aria-label={`Move ${roleLabel(roleName)} route up`} disabled={index === 0} onClick={() => moveCandidate("candidates", index, -1)}><ChevronUp aria-hidden size={13} /></button>
                                <button type="button" className="engineering-icon-button" aria-label={`Move ${roleLabel(roleName)} route down`} disabled={index === editing.candidates.length - 1} onClick={() => moveCandidate("candidates", index, 1)}><ChevronDown aria-hidden size={13} /></button>
                                <button type="button" className="engineering-icon-button" aria-label={`Remove ${roleLabel(roleName)} route`} disabled={editing.candidates.length === 1} onClick={() => removeCandidate("candidates", index)}><Trash2 aria-hidden size={13} /></button>
                              </div>
                            ))}
                            <Button variant="secondary" disabled={engineeringModelOptions.length <= editing.candidates.length + editing.optionalCandidates.length} onClick={() => addCandidate("candidates")}><Plus aria-hidden size={13} /> {t("settings.engineering.editor.addFallback")}</Button>
                            <small>{t("settings.engineering.editor.optional")}</small>
                            {editing.optionalCandidates.map((candidate, index) => (
                              <div className="engineering-route-editor" key={`optional-${index}`}>
                                <span>{t("settings.engineering.editor.optionalRoute")}</span>
                                <select aria-label={`${roleLabel(roleName)} optional ${index + 1} model`} value={candidate.model} onChange={(event) => editCandidate("optionalCandidates", index, { model: event.target.value })}>
                                  {engineeringModelOptions.map((model) => <option key={model.slug} value={model.slug}>{model.displayName} · {model.slug}</option>)}
                                </select>
                                <select aria-label={`${roleLabel(roleName)} optional ${index + 1} effort`} value={candidate.effort || "default"} onChange={(event) => editCandidate("optionalCandidates", index, { effort: event.target.value })}>
                                  {candidateEfforts(candidate.model, candidate.effort).map((effort) => <option key={effort} value={effort}>{effort === "default" ? t("settings.engineering.effort.defaultOption") : effort}</option>)}
                                </select>
                                <button type="button" className="engineering-icon-button" aria-label={`Move ${roleLabel(roleName)} optional route up`} disabled={index === 0} onClick={() => moveCandidate("optionalCandidates", index, -1)}><ChevronUp aria-hidden size={13} /></button>
                                <button type="button" className="engineering-icon-button" aria-label={`Move ${roleLabel(roleName)} optional route down`} disabled={index === editing.optionalCandidates.length - 1} onClick={() => moveCandidate("optionalCandidates", index, 1)}><ChevronDown aria-hidden size={13} /></button>
                                <button type="button" className="engineering-icon-button" aria-label={`Remove ${roleLabel(roleName)} optional route`} onClick={() => removeCandidate("optionalCandidates", index)}><Trash2 aria-hidden size={13} /></button>
                              </div>
                            ))}
                            <Button variant="secondary" disabled={engineeringModelOptions.length <= editing.candidates.length + editing.optionalCandidates.length} onClick={() => addCandidate("optionalCandidates")}><Plus aria-hidden size={13} /> {t("settings.engineering.editor.addOptional")}</Button>
                            <small>{t("settings.engineering.effort.help")}</small>
                            <div className="engineering-editor-actions">
                              <Button variant="secondary" disabled={!api || engineeringMutationPending || engineering?.revision === null} onClick={() => {
                                if (!api || engineering?.revision === null || engineering?.revision === undefined) return;
                                setEngineeringMutationPending(true);
                                let saved = false;
                                void runAction(t("settings.engineering.action.reset"), async () => {
                                  const result = await api.setEngineeringRole(roleName, [], [], engineering.revision as number, true);
                                  saved = true;
                                  return result;
                                }).finally(() => {
                                  setEngineeringMutationPending(false);
                                  if (saved) setEngineeringEditor(null);
                                });
                              }}><RotateCcw aria-hidden size={13} /> {t("settings.engineering.editor.reset")}</Button>
                              <Button variant="secondary" disabled={engineeringMutationPending} onClick={() => setEngineeringEditor(null)}><X aria-hidden size={13} /> {t("common.cancel")}</Button>
                              <Button disabled={!api || engineeringMutationPending || engineering?.revision === null} onClick={() => {
                                if (!api || engineering?.revision === null || engineering?.revision === undefined) return;
                                setEngineeringMutationPending(true);
                                let saved = false;
                                void runAction(t("settings.engineering.action.save"), async () => {
                                  const result = await api.setEngineeringRole(roleName, editing.candidates, editing.optionalCandidates, engineering.revision as number);
                                  saved = true;
                                  return result;
                                }).finally(() => {
                                  setEngineeringMutationPending(false);
                                  if (saved) setEngineeringEditor(null);
                                });
                              }}>{t("common.save")}</Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div>
                              <strong>{roleLabel(roleName)}</strong>
                              <small>{primary
                                ? t("settings.engineering.role.primary", { route: candidateLabel(primary, t, engineeringModels) })
                                : t("settings.engineering.role.unavailable")}</small>
                              <small>{fallbacks.length
                                ? t("settings.engineering.role.fallbacks", {
                                    routes: fallbacks.map((candidate) => candidateLabel(candidate, t, engineeringModels)).join(" → "),
                                  })
                                : t("settings.engineering.role.noFallbacks")}</small>
                              {optionalCandidates.length ? (
                                <small>{t("settings.engineering.role.optional", {
                                  routes: optionalCandidates.map((candidate) => candidateLabel(candidate, t, engineeringModels)).join(" · "),
                                })}</small>
                              ) : null}
                            </div>
                            <Button aria-label={`Edit ${roleLabel(roleName)} routing`} variant="secondary" disabled={!api || engineeringMutationPending || engineeringEditor !== null} onClick={() => setEngineeringEditor({
                              kind: "role",
                              role: roleName,
                              candidates: candidates.map((candidate) => ({ ...candidate })),
                              optionalCandidates: optionalCandidates.map((candidate) => ({ ...candidate })),
                            })}><Pencil aria-hidden size={13} /> {t("common.edit")}</Button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
            <div className="surface-summary">
              <ShieldCheck aria-hidden size={20} strokeWidth={1.6} />
              <div>
                <strong>{t("settings.engineering.usage.title")} · <Badge tone={engineeringUsage.tone}>{engineeringUsage.label}</Badge></strong>
                <small>{engineeringUsage.detail}</small>
              </div>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.routing.title")} description={t("settings.routing.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.signedRouting.title")}</strong><small>{t("settings.signedRouting.detail")}</small></div>
                <Toggle checked={optimisticToggles.value("signed-routing", target?.signedRouting === true)} disabled={!api || !target} label={t("settings.signedRouting.title")} onChange={(enabled) => api && void optimisticToggles.mutate("signed-routing", enabled, "Change signed routing", () => api.setSignedRouting(enabled))} />
              </div>
              <div className="setting-row">
                <div>
                  <strong>{t("settings.chatgptSession.title")}</strong>
                  <small>{t("settings.chatgptSession.detail")} {sessionSharingLabel}</small>
                </div>
                <Toggle
                  checked={sessionSharingEnabled}
                  disabled={!api || !chatgptSession || (!sessionSharingEnabled && chatgptSession.session !== "usable")}
                  label={t("settings.chatgptSession.title")}
                  onChange={(enabled) => {
                    if (!api) return;
                    if (enabled) setConfirmSessionSharing(true);
                    else void runAction(t("settings.chatgptSession.action.disable"), () => api.setChatGptSessionSharing(false));
                  }}
                />
              </div>
            </div>
            <InlineNotice tone="neutral" title={t("settings.restart.title")}>{t("settings.restart.body")}</InlineNotice>
          </section>

          <section className="panel-section">
            <SectionHeading
              title="ChatGPT accounts"
              description="Save multiple ChatGPT logins and choose which one native Codex chats use. Provider routes keep their own credentials."
            />
            {accountPoolError ? (
              <InlineNotice tone="danger" title="ChatGPT account state unavailable">
                {accountPoolError} The protected account list was not treated as empty; repair that state before adding, selecting, or removing accounts.
              </InlineNotice>
            ) : loginError ? (
              <InlineNotice tone="danger" title="ChatGPT login did not complete">
                {loginError} Retry the login when you are ready.
              </InlineNotice>
            ) : accountPool?.profile?.pending ? (
              <InlineNotice tone="neutral" title="Account switch pending">
                Close Codex completely. The selected login will be activated before the next launch.
              </InlineNotice>
            ) : null}
            <div className="settings-actions subscription-account-create">
              <input
                aria-label="New ChatGPT account label"
                value={newAccountLabel}
                maxLength={120}
                placeholder="Account label (optional)"
                onChange={(event) => setNewAccountLabel(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={!api || Boolean(accountPoolError)}
                onClick={() => void addSubscriptionAccount()}
              ><Plus aria-hidden size={14} strokeWidth={1.7} /> Add account</Button>
            </div>
            <div className="settings-list">
              {subscriptionAccounts.map((account) => {
                const optimisticPending = isOptimisticAccountId(account.id);
                const accountLoginAttempt = accountPool?.loginAttempts?.[account.id];
                const status = optimisticPending
                  ? "Adding…"
                  : account.subscription?.usable ? "Ready" : account.subscription?.expired ? "Session expired" : "Sign-in required";
                const title = account.subscription?.email || account.label || "ChatGPT account";
                const label = account.subscription?.email && account.label ? `${account.label} · ` : "";
                const usage = account.subscription?.usage;
                const usageLabel = optimisticPending
                  ? "Saving account"
                  : usage && Number.isFinite(usage.remainingPercent)
                    ? `${usage.period} · ${Math.round(usage.remainingPercent)}% remaining`
                    : "Usage unavailable";
                return (
                  <div
                    className="setting-row subscription-account-row"
                    key={account.id}
                    data-optimistic={optimisticPending ? "true" : undefined}
                  >
                    <div>
                      <strong><UserRound aria-hidden size={14} strokeWidth={1.7} /> {title} {accountSelection === account.id ? <Badge tone="accent">Selected</Badge> : null}</strong>
                      <small>{label}{status}{account.subscription?.expiresInHours !== undefined ? ` · ${account.subscription.expiresInHours}h token` : ""} · {usageLabel}</small>
                      {accountLoginAttempt?.status === "failed" ? <small>{accountLoginAttempt.error}</small> : null}
                    </div>
                    <div className="settings-actions">
                      <Button
                        variant={accountSelection === account.id ? "secondary" : "ghost"}
                        aria-pressed={accountSelection === account.id}
                        aria-label={accountSelection === account.id ? `Selected ChatGPT account: ${title}` : `Select ChatGPT account: ${title}`}
                        disabled={!api || optimisticPending}
                        onClick={() => api && void runAction("Switch ChatGPT account", () => api.setChatGptAccountSelection(account.id))}
                      >{accountSelection === account.id ? <><Check aria-hidden size={13} strokeWidth={1.9} /> Selected</> : <><Check aria-hidden size={13} strokeWidth={1.9} /> Select</>}</Button>
                      <Button
                        variant="ghost"
                        disabled={!api || optimisticPending || account.state !== "active" || accountLoginAttempt?.retryable === false || (account.subscription?.usable === true && accountLoginAttempt?.status !== "failed") || loginPendingId === account.id}
                        onClick={() => {
                          if (!api) return;
                          setLoginError(null);
                          setLoginRetryingId(accountLoginAttempt?.status === "failed" ? account.id : null);
                          setLoginPendingId(account.id);
                          void runAction(`Login ${account.label || "ChatGPT account"}`, async () => {
                            try {
                              return await api.loginChatGptSubscriptionAccount(account.id);
                            } catch (error) {
                              // App.runAction deliberately owns and swallows
                              // action failures after showing the toast. Clear
                              // our local pending owner before rethrowing so a
                              // launch/pre-handoff failure cannot leave the
                              // 1.5-second completion poll running forever.
                              setLoginPendingId(null);
                              setLoginRetryingId(null);
                              throw error;
                            }
                          });
                        }}
                      ><LogIn aria-hidden size={13} strokeWidth={1.7} /> Login</Button>
                      <Button
                        variant="ghost"
                        disabled={!api || optimisticPending || account.state === "revoked" || accountLoginAttempt?.retryable === false || accountLoginAttempt?.removable === false || loginPendingId === account.id}
                        onClick={() => setRemoveAccountId(account.id)}
                      ><Trash2 aria-hidden size={13} strokeWidth={1.7} /> Remove</Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {!accountPoolError && !subscriptionAccounts.length ? (
              <div className="surface-summary"><ShieldCheck aria-hidden size={20} strokeWidth={1.6} /><div><strong>No saved ChatGPT accounts</strong><small>Add a login to create its isolated account profile.</small></div></div>
            ) : null}
          </section>

          <section className="panel-section">
            <SectionHeading
              title="Claude accounts"
              description="Save multiple Claude subscription accounts and automatically rotate them on rate limits. Anthropic API and Claude Code routes use these accounts."
            />
            {claudeAccountPoolError ? (
              <InlineNotice tone="danger" title="Claude account state unavailable">
                {claudeAccountPoolError}
              </InlineNotice>
            ) : claudeAccountError ? (
              <InlineNotice tone="danger" title="Claude account import failed">
                {claudeAccountError}
              </InlineNotice>
            ) : null}
            <div className="settings-actions claude-account-create">
              <input
                aria-label="New Claude account label"
                value={newClaudeAccountLabel}
                maxLength={120}
                placeholder="Optional nickname (e.g. Work, Personal)"
                onChange={(event) => setNewClaudeAccountLabel(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={!api || Boolean(claudeAccountPoolError)}
                onClick={() => void addClaudeAccount()}
              ><Plus aria-hidden size={14} strokeWidth={1.7} /> Add Claude account</Button>
              <Button
                variant="ghost"
                disabled={!api}
                onClick={() => {
                  if (!api) return;
                  const emailCandidate = newClaudeAccountLabel.trim().includes("@") ? newClaudeAccountLabel.trim() : undefined;
                  void runAction("Sign in with Claude CLI", () => api.loginClaudeSubscriptionAccount(emailCandidate));
                }}
              ><LogIn aria-hidden size={14} strokeWidth={1.7} /> Sign in in Terminal</Button>
              <Button
                variant="ghost"
                title="Sync live usage and quota reset times from Anthropic"
                disabled={!api}
                onClick={() => api && void runAction("Sync Claude account usage", () => api.syncClaudeAccountUsage())}
              ><RefreshCw aria-hidden size={14} strokeWidth={1.7} /> Sync usage</Button>
            </div>
            <div className="settings-list">
              {claudeAccounts.map((account) => {
                const isSelected = claudeAccountSelection === account.id;
                const isPaused = account.state === "paused";
                const isAuthInvalid = account.health?.state === "reauth-required";
                const isCooling = account.health?.state === "cooling";
                const isDrained = account.health?.state === "drained";

                const statusLabel = isPaused
                  ? "Paused"
                  : isAuthInvalid
                    ? "Sign-in required"
                    : isCooling
                      ? "Cooling down"
                      : isDrained
                        ? "Quota exhausted"
                        : "Ready";

                const title = account.identity?.email || account.label || "Claude account";
                const labelPrefix = account.identity?.email && account.label && account.label.toLowerCase() !== account.identity.email.toLowerCase() ? `${account.label} · ` : "";
                const tier = account.tier ? ` · ${account.tier.toUpperCase()}` : "";

                const fiveHourUsage = account.usage?.fiveHour;
                const weeklyUsage = account.usage?.weekly;
                const usageParts: string[] = [];
                if (fiveHourUsage && Number.isFinite(fiveHourUsage.remainingPercent)) {
                  const resetStr = formatTimeUntil(fiveHourUsage.resetsAtMs);
                  usageParts.push(`5h: ${Math.round(fiveHourUsage.remainingPercent!)}% remaining${resetStr ? ` (${resetStr})` : ""}`);
                }
                if (weeklyUsage && Number.isFinite(weeklyUsage.remainingPercent)) {
                  const resetStr = formatTimeUntil(weeklyUsage.resetsAtMs);
                  usageParts.push(`weekly: ${Math.round(weeklyUsage.remainingPercent!)}% remaining${resetStr ? ` (${resetStr})` : ""}`);
                }
                const usageLabel = usageParts.length > 0 ? usageParts.join(" · ") : "Usage pending first request";

                return (
                  <div
                    className="setting-row claude-account-row"
                    key={account.id}
                  >
                    <div>
                      <strong><UserRound aria-hidden size={14} strokeWidth={1.7} /> {title} {isSelected ? <Badge tone="accent">Selected</Badge> : null} {isPaused ? <Badge tone="neutral">Paused</Badge> : null}</strong>
                      <small>{labelPrefix}{statusLabel}{tier} · {usageLabel}</small>
                    </div>
                    <div className="settings-actions">
                      <Button
                        variant={isSelected ? "secondary" : "ghost"}
                        aria-pressed={isSelected}
                        aria-label={isSelected ? `Selected Claude account: ${title}` : `Select Claude account: ${title}`}
                        disabled={!api || isPaused}
                        onClick={() => api && void runAction("Switch Claude account", () => api.setClaudeAccountSelection(account.id))}
                      >{isSelected ? <><Check aria-hidden size={13} strokeWidth={1.9} /> Selected</> : <><Check aria-hidden size={13} strokeWidth={1.9} /> Select</>}</Button>
                      <Button
                        variant="ghost"
                        title={(!isAuthInvalid && account.subscription?.status === "usable") ? "Account is authenticated and ready. Click to re-authenticate." : "Sign in to this account"}
                        disabled={!api || isPaused}
                        onClick={() => api && void runAction(`Login ${title}`, () => api.loginClaudeSubscriptionAccount(account.id))}
                      ><LogIn aria-hidden size={13} strokeWidth={1.7} /> Login</Button>
                      <Button
                        variant="ghost"
                        disabled={!api}
                        onClick={() => api && void runAction(isPaused ? "Enable Claude account" : "Pause Claude account", () => api.toggleClaudeAccountState(account.id, isPaused ? "enable" : "disable"))}
                      >{isPaused ? "Resume" : "Pause"}</Button>
                      <Button
                        variant="ghost"
                        disabled={!api}
                        onClick={() => setRemoveClaudeAccountId(account.id)}
                      ><Trash2 aria-hidden size={13} strokeWidth={1.7} /> Remove</Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {!claudeAccountPoolError && !claudeAccounts.length ? (
              <div className="surface-summary"><ShieldCheck aria-hidden size={20} strokeWidth={1.6} /><div><strong>No saved Claude accounts</strong><small>Log in with 'claude' in terminal, then click 'Add account' to import into the rotation pool.</small></div></div>
            ) : null}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.service.title")} description={t("settings.service.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.presence.title")}</strong><small>{t("settings.presence.detail")}</small></div>
                <select
                  aria-label={t("settings.presence.title")}
                  value={presence?.mode || "always"}
                  disabled={!api}
                  onChange={(event) => api && void runAction("Change presence mode", () => api.setPresence(event.target.value as "always" | "follow-codex"))}
                >
                  <option value="always">{t("settings.presence.always")}</option>
                  <option value="follow-codex">{t("settings.presence.followCodex")}</option>
                </select>
              </div>
              <div className="setting-row static-row">
                <div><strong>{t("settings.serviceState.title")}</strong><small>{t("settings.serviceState.detail")}</small></div>
                <Badge tone={health?.ok ? "success" : "danger"}>{health?.ok ? t("settings.serviceState.running") : t("settings.serviceState.offline")}</Badge>
              </div>
            </div>
            <div className="settings-actions">
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction("Start router service", () => api.controlService("start"))}><Server aria-hidden size={14} strokeWidth={1.7} /> {t("settings.action.start")}</Button>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.context.title")} description={t("settings.context.description")} />
            {aging ? (
              <>
                <div className="settings-list">
                  <div className="setting-row">
                    <div><strong>{t("settings.context.enable.title")}</strong><small>{t("settings.context.enable.detail")}</small></div>
                    <Toggle checked={toolResultAgingEnabled} disabled={!api || agingLocked} label={t("settings.context.enable.title")} onChange={(enabled) => api && void optimisticToggles.mutate("tool-result-aging", enabled, "Change Token maxxing", () => api.setToolResultAging(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.context.native.title")}</strong><small>{t("settings.context.native.detail")}</small></div>
                    <Toggle checked={optimisticToggles.value("native-tool-result-aging", aging.nativeEnabled === true)} disabled={!api || agingLocked || !toolResultAgingEnabled} label={t("settings.context.native.title")} onChange={(enabled) => api && void optimisticToggles.mutate("native-tool-result-aging", enabled, "Change native result compaction", () => api.setNativeToolResultAging(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.context.ttl.title")}</strong><small>{t("settings.context.ttl.detail")}</small></div>
                    <select
                      aria-label={t("settings.context.ttl.title")}
                      value={ttlValue}
                      disabled={!api || agingLocked}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const days = raw === "default" ? "default" : Number(raw);
                        if (api) void runAction("Change retention window", () => api.setToolResultRetentionTtl(days));
                      }}
                    >
                      <option value="default">{t("settings.context.ttl.default", { days: RETENTION_DEFAULT_TTL_DAYS })}</option>
                      {ttlChoices.map((days) => <option key={days} value={String(days)}>{t("settings.context.ttl.days", { days })}</option>)}
                      <option value="0">{t("settings.context.ttl.forever")}</option>
                    </select>
                  </div>
                </div>
                {agingLocked ? (
                  <InlineNotice tone="warning" title={t("settings.context.envOverride.title")}>{t("settings.context.envOverride.body")}</InlineNotice>
                ) : null}
                <p className="section-footnote">
                  {hasSavings
                    ? t("settings.context.savings", {
                        tokens: compactNumber(stats?.estimatedTokensSaved),
                        size: formatBytes(stats?.bytesSaved),
                        requests: compactNumber(stats?.requests),
                      })
                    : t("settings.context.noSavings")}
                </p>
              </>
            ) : <InlineNotice tone="neutral" title={t("settings.context.title")}>{t("settings.context.unavailable")}</InlineNotice>}
          </section>
        </div>

        <div className="page-stack">
          <section className="panel-section">
            <SectionHeading title={t("settings.vision.title")} description={t("settings.vision.description")} />
            {bridge ? (
              <>
                <div className="settings-list">
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.enable.title")}</strong><small>{t("settings.vision.enable.detail")}</small></div>
                    <Toggle checked={optimisticToggles.value("vision-bridge", bridge.enabled === true)} disabled={!api} label={t("settings.vision.enable.title")} onChange={(enabled) => api && void optimisticToggles.mutate("vision-bridge", enabled, "Change vision bridge", () => api.setVisionBridgeEnabled(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.engine.title")}</strong><small>{t("settings.vision.engine.detail")}</small></div>
                    <select
                      aria-label={t("settings.vision.engine.title")}
                      value={selectedEngine}
                      disabled={!api}
                      onChange={(event) => api && void runAction("Change vision engine", () => api.setVisionBridgeEngine(event.target.value))}
                    >
                      {/* No standing "Auto" choice, matching the tray: the ranking behind it
                          scored cost by slug spelling, so it tied across a normal install and
                          resolved alphabetically. It stays visible only while the install is
                          still on it, so the row reports the truth without offering it back. */}
                      {selectedEngine === "auto" ? <option value="auto">{t("settings.vision.engine.auto", { name: bridge.resolvedEngineName || bridge.resolvedEngine || "—" })}</option> : null}
                      {unlistedEngine ? <option value={unlistedEngine.slug}>{unlistedEngine.displayName}</option> : null}
                      {paidEngines.length ? (
                        <optgroup label={t("settings.vision.engine.paid")}>
                          {paidEngines.map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                        </optgroup>
                      ) : null}
                      {nativeEngines.length ? (
                        <optgroup label={t("settings.vision.engine.native")}>
                          {nativeEngines.map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                        </optgroup>
                      ) : null}
                      {bridge.local ? <option value="local">{t("settings.vision.engine.local", { name: bridge.local.model || "runtime" })}</option> : null}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.effort.title")}</strong><small>{effortOptions.length ? t("settings.vision.effort.detail") : t("settings.vision.effort.none")}</small></div>
                    <select
                      aria-label={t("settings.vision.effort.title")}
                      value={selectedEffort}
                      disabled={!api || !effortOptions.length}
                      onChange={(event) => api && void runAction("Change vision effort", () => api.setVisionBridgeEffort(event.target.value))}
                    >
                      <option value="default">{t("settings.vision.effort.default")}</option>
                      {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                  </div>
                </div>
                <div className="surface-summary">
                  <Eye aria-hidden size={20} strokeWidth={1.6} />
                  <div><strong>{bridge.resolvedEngineName || bridge.resolvedEngine || bridge.engine || "—"}</strong><small>{t("settings.vision.localNote")}</small></div>
                </div>
              </>
            ) : <InlineNotice tone="neutral" title={t("settings.vision.title")}>{t("settings.vision.unavailable")}</InlineNotice>}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.desktop.title")} description={t("settings.desktop.description")} />
            <div className="surface-summary">
              <AppWindow aria-hidden size={20} strokeWidth={1.6} />
              <div><strong>{t("settings.desktop.tray.title")}</strong><small>{t("settings.desktop.tray.detail")}</small></div>
            </div>
            <div className="settings-actions">
              <Button variant="secondary" disabled={!api || trayControlsUnavailable} onClick={() => api && void runAction("Enable desktop tray", () => api.controlTray("enable"))}>{t("settings.desktop.enable")}</Button>
              <Button variant="secondary" disabled={!api || trayControlsUnavailable} onClick={() => api && void runAction("Restart desktop tray", () => api.controlTray("restart"))}>{t("settings.desktop.restart")}</Button>
              <Button variant="ghost" disabled={!api || trayControlsUnavailable} onClick={() => setConfirmTrayDisable(true)}>{t("settings.desktop.disable")}</Button>
            </div>
            {trayControlsUnavailable ? (
              <InlineNotice tone="neutral" title={t("settings.desktop.unavailable.title")}>
                {t("settings.desktop.unavailable.body")}
              </InlineNotice>
            ) : null}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.appearance.title")} description={t("settings.appearance.description")} />
            <div className="theme-picker" role="radiogroup" aria-label={t("settings.appearance.aria")}>
              <button role="radio" aria-checked={theme === "light"} className={theme === "light" ? "is-active" : ""} onClick={() => onTheme("light")}><Sun aria-hidden size={16} strokeWidth={1.7} /><span><strong>{t("settings.appearance.light")}</strong><small>{t("settings.appearance.lightDetail")}</small></span></button>
              <button role="radio" aria-checked={theme === "dark"} className={theme === "dark" ? "is-active" : ""} onClick={() => onTheme("dark")}><Moon aria-hidden size={16} strokeWidth={1.7} /><span><strong>{t("settings.appearance.dark")}</strong><small>{t("settings.appearance.darkDetail")}</small></span></button>
            </div>
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.language.title")}</strong><small>{t("settings.language.detail")}</small></div>
                <select
                  aria-label={t("settings.language.aria")}
                  value={language}
                  onChange={(event) => onLanguage(event.target.value as LanguageId)}
                >
                  {LANGUAGE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </div>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.maintenance.title")} description={t("settings.maintenance.description")} />
            <div className="surface-summary">
              <Wrench aria-hidden size={20} strokeWidth={1.6} />
              <div><strong>{t("settings.maintenance.repairTitle")}</strong><small>{t("settings.maintenance.footnote")}</small></div>
            </div>
            <div className="settings-actions">
              <Button variant="primary" disabled={!api || repairing} onClick={() => setConfirmRepair(true)}>
                {repairing ? t("settings.maintenance.fixRunning") : t("settings.maintenance.fix")}
              </Button>
            </div>
            {repairReport && repairReport.ok ? (
              <InlineNotice tone="success" title={t("settings.maintenance.fixDone")}>
                {t("settings.maintenance.fixDoneDetail")}
              </InlineNotice>
            ) : null}
            {repairFailures.length ? (
              <InlineNotice tone="danger" title={t("settings.maintenance.fixIncomplete")}>
                {/* Repair ran; these checks still fail. Naming them with their
                    own remedy is the whole point of showing the report -- a
                    bare "it failed" would send the user back to the terminal
                    the button exists to replace. */}
                {repairFailures.map((check) => `${check.name}: ${check.detail || ""}${check.fix ? ` — ${check.fix}` : ""}`).join(" · ")}
              </InlineNotice>
            ) : null}
            <InlineNotice tone="neutral" title={t("settings.maintenance.update")}>
              {t("settings.maintenance.updateNote")}
            </InlineNotice>
          </section>
        </div>
      </div>

      <Dialog
        open={confirmSessionSharing}
        title={t("settings.chatgptSession.confirm.title")}
        description={t("settings.chatgptSession.confirm.description")}
        onClose={() => setConfirmSessionSharing(false)}
      >
        <p className="dialog-copy">{t("settings.chatgptSession.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmSessionSharing(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            setConfirmSessionSharing(false);
            if (api) void runAction(t("settings.chatgptSession.action.enable"), () => api.setChatGptSessionSharing(true));
          }}>{t("settings.chatgptSession.confirm.enable")}</Button>
        </div>
      </Dialog>

      <Dialog
        open={confirmRepair}
        title={t("settings.maintenance.confirm.title")}
        description={t("settings.maintenance.confirm.description")}
        onClose={() => setConfirmRepair(false)}
      >
        <p className="dialog-copy">{t("settings.maintenance.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmRepair(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            setConfirmRepair(false);
            void runRepair();
          }}>{t("settings.maintenance.fix")}</Button>
        </div>
      </Dialog>

      <Dialog open={confirmTrayDisable} title={t("settings.desktop.confirm.title")} description={t("settings.desktop.confirm.description")} onClose={() => setConfirmTrayDisable(false)}>
        <p className="dialog-copy">{t("settings.desktop.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmTrayDisable(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="danger" disabled={trayControlsUnavailable} onClick={() => {
            setConfirmTrayDisable(false);
            if (api) void runAction("Disable desktop tray", () => api.controlTray("disable"));
          }}>{t("settings.desktop.disable")}</Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(removeAccountId)}
        title="Remove ChatGPT subscription account?"
        description="This revokes the pool entry and deletes its isolated Codex login profile."
        onClose={() => setRemoveAccountId(null)}
      >
        <p className="dialog-copy">The account's local OAuth profile will be removed. If it is active, close Codex first; another saved account must be activated before removal.</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoveAccountId(null)}>Cancel</Button>
          <Button variant="danger" disabled={!api || !removeAccountId || loginPendingId === removeAccountId} onClick={() => {
            const id = removeAccountId;
            if (id) void removeSubscriptionAccount(id);
          }}>Remove account</Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(removeClaudeAccountId)}
        title="Remove Claude subscription account?"
        description="This revokes the pool entry and deletes its isolated credentials profile."
        onClose={() => setRemoveClaudeAccountId(null)}
      >
        <p className="dialog-copy">The account will be removed from the rotation pool and its isolated credential home deleted.</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoveClaudeAccountId(null)}>Cancel</Button>
          <Button variant="danger" disabled={!api || !removeClaudeAccountId} onClick={() => {
            const id = removeClaudeAccountId;
            if (id) void removeClaudeAccount(id);
          }}>Remove account</Button>
        </div>
      </Dialog>
    </>
  );
}
