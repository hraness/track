import { runCommandAgentTurn } from "./command-agent.ts";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  configDir,
  defaultAuthEnv,
  PROVIDER_CHOICES,
  readConfig,
  resolveGatewayKey,
  resolveOpenRouterKey,
  type AuthEnv,
  type CredentialSource,
  type DawgConfig,
  type ProviderChoice,
  type SubscriptionSlot,
} from "../auth/credentials.ts";
import { systemRunner } from "../auth/runner.ts";
import {
  runAgentTurn,
  type AgentBudget,
  type AgentEvent,
  type AgentHost,
  type AgentTurnResult,
} from "./agent.ts";
import {
  createGatewayClient,
  createOpenRouterClient,
  type ApiProvider,
  type GatewayClient,
} from "./gateway.ts";
import {
  defaultModelId,
  fallbackModelId,
  MODEL_CATALOG,
  modelAlias,
  resolveModelChoice,
  FAST_MODEL_ALIAS,
} from "./models.ts";
import { runTextAgentTurn } from "./xcb-agent.ts";
import { AGENT_TOOLS } from "./tools.ts";
import { SUBAGENT_LIMITS } from "./subagent-tasks.ts";
import type { SubagentHost } from "./agent.ts";
import {
  describeReason,
  readCapabilities,
  resolveXcbBin,
  shortModelLabel,
  type XcbAccount,
  xcbGenerateWithRetry,
  type XcbCapabilities,
} from "./xcb.ts";

/**
 * Which model backend a turn uses. `gateway` and `openrouter` run the
 * streaming tool-calling loop on an OpenAI-compatible API; `xcb` emulates
 * tools over `xcb --json generate` with a Codex or Claude subscription;
 * `offline` means only direct commands.
 */
export type ApiSelection = Readonly<{
  kind: ApiProvider;
  choice: ProviderChoice;
  apiKey: string;
  source: CredentialSource;
  /** The exact provider model ID (`anthropic/claude-opus-5.5`). */
  modelId: string;
}>;
export type XcbSelection = Readonly<{
  kind: "xcb";
  choice: ProviderChoice;
  /** `codex` or `claude` (or another xcb provider for `--xcb`). */
  family: string;
  bin: string;
  account: string;
  accountLabel: string;
  model: string;
  /** xcb admits this account on its first call, which takes longer. */
  admissionPending?: boolean;
}>;
export type ProviderSelection =
  | ApiSelection
  | XcbSelection
  | Readonly<{
      kind: "offline";
      choice: ProviderChoice;
      reason: string;
      /**
       * Set when a saved choice stopped working (key revoked, account gone):
       * the host says so once and offers the picker, never another provider.
       */
      invalidSaved?: boolean;
    }>;

export function isApiSelection(
  selection: ProviderSelection,
): selection is ApiSelection {
  return selection.kind === "gateway" || selection.kind === "openrouter";
}

export const LOGIN_HINT = "run `dawg model key` to enable the agent";
/** The small, cheap model used for one-line helpers such as session names. */
export const GATEWAY_SMALL_MODEL = "anthropic/claude-haiku-4.5";
export const OPENROUTER_SMALL_MODEL = "anthropic/claude-haiku-4.5";

export function apiClient(selection: ApiSelection): GatewayClient {
  return selection.kind === "openrouter"
    ? createOpenRouterClient({ apiKey: selection.apiKey })
    : createGatewayClient({ apiKey: selection.apiKey });
}

export function providerChoice(
  env: Readonly<Record<string, string | undefined>>,
  saved: ProviderChoice | undefined,
): ProviderChoice {
  const fromEnv = env.DAWG_PROVIDER?.trim().toLowerCase();
  if (fromEnv && (PROVIDER_CHOICES as readonly string[]).includes(fromEnv))
    return fromEnv as ProviderChoice;
  return saved ?? "auto";
}

/**
 * The model for a key-based provider: `DAWG_MODEL`, then the model saved by
 * `/model` or `dawg model key`, then Opus 5.5. Throws on an unknown `DAWG_MODEL`.
 */
export function apiModelId(
  service: ApiProvider,
  env: Readonly<Record<string, string | undefined>>,
  config: DawgConfig,
): string {
  const fromEnv = env.DAWG_MODEL?.trim();
  if (fromEnv) {
    const id = resolveModelChoice(service, fromEnv);
    if (!id)
      throw new Error(
        `unknown DAWG_MODEL "${fromEnv.slice(0, 40)}"; use one of ${MODEL_CATALOG.map((row) => row.alias).join(", ")} or a vendor/model ID`,
      );
    return id;
  }
  return (
    (service === "openrouter" ? config.openrouterModel : config.gatewayModel) ??
    defaultModelId(service)
  );
}

const FAMILY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  codex: "ChatGPT/Codex subscription",
  claude: "Claude subscription",
  xcb: "xcb account",
});

/**
 * Resolve the provider: `DAWG_PROVIDER`, then the choice saved by `dawg
 * login` or `/model`, then `auto` (AI Gateway key, then OpenRouter key, then
 * a ready Codex or Claude subscription). A saved choice that stops working
 * resolves to `offline` with `invalidSaved`; it never falls through to a
 * different provider.
 */
export async function selectProvider(
  auth: AuthEnv = defaultAuthEnv(systemRunner),
  options: { capabilities?: XcbCapabilities } = {},
): Promise<ProviderSelection> {
  const config = await readConfig(auth);
  const choice = providerChoice(auth.env, config.provider);
  const explicit = choice !== "auto";
  const offline = (reason: string): ProviderSelection => ({
    kind: "offline",
    choice,
    reason,
    ...(explicit && config.provider === choice && !auth.env.DAWG_PROVIDER
      ? { invalidSaved: true }
      : {}),
  });
  for (const service of ["gateway", "openrouter"] as const) {
    if (choice !== service && choice !== "auto") continue;
    const key =
      service === "gateway"
        ? await resolveGatewayKey(auth)
        : await resolveOpenRouterKey(auth);
    if (key) {
      let modelId: string;
      try {
        modelId = apiModelId(service, auth.env, config);
      } catch (error) {
        return offline((error as Error).message);
      }
      return {
        kind: service,
        choice,
        apiKey: key.key,
        source: key.source,
        modelId,
      };
    }
    if (choice === service)
      return offline(
        `no ${service === "gateway" ? "AI Gateway" : "OpenRouter"} key any more; run \`dawg model key ${service}\``,
      );
  }
  const bin = resolveXcbBin(auth.env, auth.runner);
  if (!bin)
    return offline(
      explicit
        ? `xcb is not installed; run \`dawg model key ${choice === "xcb" ? "--xcb" : choice}\``
        : `no model configured; ${LOGIN_HINT}`,
    );
  let capabilities: XcbCapabilities;
  try {
    capabilities =
      options.capabilities ?? (await readCapabilities(bin, auth.runner));
  } catch {
    return offline(`xcb capabilities unavailable; ${LOGIN_HINT}`);
  }
  const toSelection = (
    family: string,
    account: XcbAccount,
    model: string,
  ): XcbSelection => ({
    kind: "xcb",
    choice,
    family,
    bin,
    account: account.id,
    accountLabel: account.label,
    model,
    ...(account.admission === "pending" ? { admissionPending: true } : {}),
  });
  const families: SubscriptionSlot[] =
    choice === "auto"
      ? ["codex", "claude"]
      : explicit
        ? [choice as SubscriptionSlot]
        : [];
  for (const family of families) {
    const saved = config[family];
    const inFamily = (account: XcbAccount) =>
      family === "xcb" || account.provider === family;
    if (saved) {
      const account = capabilities.accounts.find(
        (row) => row.id === saved.account,
      );
      if (
        account?.available &&
        account.models.some((model) => model.key === saved.model)
      )
        return toSelection(
          family === "xcb" ? account.provider : family,
          account,
          saved.model,
        );
      if (choice === family)
        return offline(
          `your ${FAMILY_NAMES[family]} (${account?.label ?? saved.account.slice(0, 12)}) is ${
            !account
              ? "no longer listed by xcb"
              : account.available
                ? `missing model ${saved.model}`
                : describeReason(account.reason).replace(
                    "<account>",
                    account.id,
                  )
          }; run \`dawg model key ${family === "xcb" ? "--xcb" : family}\``,
        );
    }
    // No saved pick: the first usable account, ready before admission pending.
    const usable = capabilities.accounts
      .filter(
        (account) =>
          account.available && inFamily(account) && account.models.length > 0,
      )
      .sort(
        (a, b) =>
          Number(a.admission === "pending") - Number(b.admission === "pending"),
      );
    const account = usable[0];
    if (account)
      return toSelection(
        family === "xcb" ? account.provider : family,
        account,
        account.models[0]!.key,
      );
  }
  return offline(
    explicit
      ? `no ${FAMILY_NAMES[choice] ?? choice} is ready; run \`dawg model key ${choice === "xcb" ? "--xcb" : choice}\``
      : `no model configured; ${LOGIN_HINT}`,
  );
}

/**
 * A cheap fingerprint of everything on disk and in the environment that
 * `selectProvider` reads (config.json, credentials.json, provider env vars).
 * Two stats per call; the host re-resolves the provider when it changes.
 */
export function providerFingerprint(
  dir: string = configDir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const parts = ["config.json", "credentials.json"].map((name) => {
    try {
      const info = statSync(join(dir, name));
      return `${name}:${info.size}:${info.mtimeMs}:${info.ino}`;
    } catch {
      return `${name}:-`;
    }
  });
  // Presence only: a process's environment cannot change under it, and the
  // fingerprint must never carry secret material.
  parts.push(
    `env:${env.DAWG_PROVIDER ?? "-"}:${env.AI_GATEWAY_API_KEY ? 1 : 0}:${env.OPENROUTER_API_KEY ? 1 : 0}`,
  );
  return parts.join("|");
}

/** `opus-5.5 · gateway`, `sonnet · claude`, or `offline`. */
export function providerLabel(selection: ProviderSelection): string {
  if (isApiSelection(selection))
    return `${modelAlias(selection.kind, selection.modelId)} · ${selection.kind}`;
  if (selection.kind === "xcb")
    return `${shortModelLabel(selection.model)} · ${selection.family}`;
  return "offline";
}

/** The model half of the label, for the header and spend line. */
export function selectionModel(
  selection: ProviderSelection,
): string | undefined {
  if (isApiSelection(selection))
    return modelAlias(selection.kind, selection.modelId);
  if (selection.kind === "xcb") return shortModelLabel(selection.model);
  return undefined;
}

export type ProviderTurnOptions = Readonly<{
  selection: ProviderSelection;
  prompt: string;
  /** Overrides the selection's model (tests); normally unset. */
  model?: string;
  host: AgentHost;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  budget?: AgentBudget;
  /** History id of this turn (pre-assigned by the caller); default fresh. */
  turnId?: string;
  /** Allow list of tool names (dispatch children); default every tool. */
  toolNames?: readonly string[];
  /** Injected for tests; defaults to a client built from the selection's key. */
  gatewayClient?: GatewayClient;
  runner?: AuthEnv["runner"];
}>;

/**
 * The dispatch runner for a parent turn on `selection`: children run on the
 * same provider (API children default to the fast model; xcb children use
 * the account's model) with a tool allow list and no command mode.
 */
export function subagentHostFor(
  selection: ProviderSelection,
  inject: Pick<ProviderTurnOptions, "gatewayClient" | "runner"> = {},
): SubagentHost | undefined {
  if (selection.kind !== "xcb" && !isApiSelection(selection)) return undefined;
  const api = isApiSelection(selection) ? selection : undefined;
  return {
    concurrency:
      selection.kind === "xcb"
        ? SUBAGENT_LIMITS.xcbConcurrency
        : SUBAGENT_LIMITS.concurrency,
    ...(api ? { model: FAST_MODEL_ALIAS } : {}),
    runTurn: (input) => {
      const model =
        api && input.model
          ? (resolveModelChoice(api.kind, input.model) ?? api.modelId)
          : undefined;
      return runProviderTurn({
        selection,
        prompt: input.prompt,
        host: input.host,
        budget: input.budget,
        signal: input.signal,
        onEvent: input.onEvent,
        toolNames: input.tools,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(model ? { model } : {}),
        ...inject,
      });
    },
  };
}

/** Run one agent turn on whichever provider was selected. */
export async function runProviderTurn(
  options: ProviderTurnOptions,
): Promise<AgentTurnResult> {
  const { selection } = options;
  const common = {
    prompt: options.prompt,
    host: options.host,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.toolNames
      ? {
          tools: AGENT_TOOLS.filter((tool) =>
            options.toolNames!.includes(tool.name),
          ),
        }
      : {}),
  };
  if (isApiSelection(selection)) {
    const model = options.model ?? selection.modelId;
    const fallback = fallbackModelId(selection.kind, model);
    if (options.host.commands && !options.model && !options.toolNames)
      return runCommandAgentTurn({
        ...common,
        model,
        ...(fallback ? { fallbackModel: fallback } : {}),
        client: options.gatewayClient ?? apiClient(selection),
        commands: options.host.commands,
      });
    return runAgentTurn({
      ...common,
      model,
      ...(fallback ? { fallbackModel: fallback } : {}),
      client: options.gatewayClient ?? apiClient(selection),
    });
  }
  if (selection.kind === "xcb") {
    const runner = options.runner ?? systemRunner;
    return runTextAgentTurn({
      ...common,
      generate: (prompt, call) =>
        xcbGenerateWithRetry({
          bin: selection.bin,
          runner,
          account: selection.account,
          model: selection.model,
          prompt,
          timeoutMs: call.timeoutMs,
          maxOutputBytes: call.maxOutputBytes,
          signal: call.signal,
        }),
    });
  }
  const result: AgentTurnResult = {
    type: "error",
    code: "provider",
    message: selection.reason,
    applied: 0,
    revision: options.host.snapshot().revision,
  };
  options.onEvent?.(result);
  return result;
}

export type GenerateTextOptions = Readonly<{
  /** Upper bound on reply tokens (gateway `max_tokens`; xcb gets ~8 bytes per token). */
  maxTokens: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Reuse an already-resolved provider; otherwise one is selected now. */
  selection?: ProviderSelection;
  gatewayClient?: GatewayClient;
  runner?: AuthEnv["runner"];
}>;

/**
 * One short, tool-free completion on whichever provider is configured, for
 * helpers such as the session auto-namer. Gateway uses `GATEWAY_SMALL_MODEL`;
 * xcb uses the selected account and model with a small output cap. Throws when
 * no provider is available (callers should fall back to a local default).
 * The returned text is untrusted, trimmed, and at most 512 characters.
 */
export async function generateText(
  prompt: string,
  options: GenerateTextOptions,
): Promise<string> {
  const selection = options.selection ?? (await selectProvider());
  const maxTokens = Math.min(1024, Math.max(1, Math.floor(options.maxTokens)));
  const timeoutMs = Math.min(
    60_000,
    Math.max(1_000, options.timeoutMs ?? 20_000),
  );
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const input = prompt.slice(0, 16_000);
  if (isApiSelection(selection)) {
    const client = options.gatewayClient ?? apiClient(selection);
    let text = "";
    for await (const event of client.stream(
      {
        model: "opus-5.5",
        modelId:
          selection.kind === "openrouter"
            ? OPENROUTER_SMALL_MODEL
            : GATEWAY_SMALL_MODEL,
        maxTokens,
        messages: [{ role: "user", content: input }],
        maxResponseBytes: 16 * 1024,
      },
      signal,
    )) {
      if (event.type === "text") text += event.delta;
      if (text.length > 2048) break;
    }
    return text.trim().slice(0, 512);
  }
  if (selection.kind === "xcb") {
    const text = await xcbGenerateWithRetry({
      bin: selection.bin,
      runner: options.runner ?? systemRunner,
      account: selection.account,
      model: selection.model,
      prompt: input,
      timeoutMs,
      maxOutputBytes: Math.min(4096, Math.max(64, maxTokens * 8)),
      signal,
    });
    return text.trim().slice(0, 512);
  }
  throw new Error(selection.reason);
}
