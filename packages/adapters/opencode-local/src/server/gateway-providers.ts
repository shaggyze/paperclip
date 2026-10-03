import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * Built-in OpenAI-compatible providers that OpenCode does not ship:
 *
 * - `ollama`: a local Ollama daemon at OLLAMA_BASE_URL (default
 *   http://localhost:11434/v1). Active when OLLAMA_BASE_URL is set or the
 *   configured model starts with `ollama/`.
 * - `cf-aig`: a Cloudflare AI Gateway `/compat` endpoint. Active when
 *   CLOUDFLARE_AI_GATEWAY_URL is set, or CLOUDFLARE_ACCOUNT_ID and
 *   CLOUDFLARE_AI_GATEWAY_ID are both set. Fallback routing lives in the
 *   gateway: a model id `dynamic/<route>` runs that gateway's dynamic route,
 *   which tries each configured backend in order.
 *
 * A provider with the same key in the user's opencode.json or in
 * PAPERCLIP_OPENCODE_PROVIDERS replaces these defaults.
 */
export const OLLAMA_PROVIDER_ID = "ollama";
export const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cf-aig";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_CLOUDFLARE_AI_GATEWAY_MODELS = ["dynamic/free-agents"] as const;

type ResolveEnv = (name: string) => string | undefined;

function envValue(resolve: ResolveEnv, name: string): string | null {
  const value = resolve(name)?.trim();
  return value ? value : null;
}

function splitList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function modelsMap(ids: string[]): Record<string, { name: string }> {
  return Object.fromEntries(ids.map((id) => [id, { name: id }]));
}

/** Ollama's OpenAI-compatible base URL always ends in `/v1`. */
export function resolveOllamaBaseUrl(resolve: ResolveEnv): string {
  const raw = envValue(resolve, "OLLAMA_BASE_URL") ?? envValue(resolve, "OLLAMA_HOST");
  if (!raw) return DEFAULT_OLLAMA_BASE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const trimmed = withScheme.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function resolveCloudflareAiGatewayUrl(resolve: ResolveEnv): string | null {
  const explicit = envValue(resolve, "CLOUDFLARE_AI_GATEWAY_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const accountId = envValue(resolve, "CLOUDFLARE_ACCOUNT_ID");
  const gatewayId = envValue(resolve, "CLOUDFLARE_AI_GATEWAY_ID");
  if (!accountId || !gatewayId) return null;
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/compat`;
}

export function cloudflareAiGatewayModelIds(resolve: ResolveEnv): string[] {
  const configured = splitList(envValue(resolve, "CLOUDFLARE_AI_GATEWAY_MODELS"));
  return configured.length > 0 ? configured : [...DEFAULT_CLOUDFLARE_AI_GATEWAY_MODELS];
}

function ollamaActive(resolve: ResolveEnv, configuredProvider: string | null): boolean {
  return (
    configuredProvider === OLLAMA_PROVIDER_ID ||
    envValue(resolve, "OLLAMA_BASE_URL") !== null
  );
}

/** OpenCode `provider` entries for the active built-in gateways. */
export function builtinGatewayProviders(
  resolve: ResolveEnv,
  configuredModel?: string | null,
): Record<string, Record<string, unknown>> {
  const configuredProvider = configuredModel?.includes("/")
    ? configuredModel.slice(0, configuredModel.indexOf("/"))
    : null;
  const providers: Record<string, Record<string, unknown>> = {};

  if (ollamaActive(resolve, configuredProvider)) {
    providers[OLLAMA_PROVIDER_ID] = {
      npm: "@ai-sdk/openai-compatible",
      name: "Ollama (local)",
      options: {
        baseURL: resolveOllamaBaseUrl(resolve),
        // Ollama ignores the key, but the OpenAI client requires one.
        apiKey: envValue(resolve, "OLLAMA_API_KEY") ?? "ollama",
      },
      models: modelsMap(splitList(envValue(resolve, "OLLAMA_MODELS"))),
    };
  }

  const gatewayUrl = resolveCloudflareAiGatewayUrl(resolve);
  if (gatewayUrl) {
    const gatewayToken = envValue(resolve, "CLOUDFLARE_AI_GATEWAY_TOKEN");
    // The gateway may forward Authorization upstream, so the gateway token
    // never goes there. With keys stored in the gateway (BYOK) a placeholder works.
    const providerKey = envValue(resolve, "CLOUDFLARE_AI_GATEWAY_PROVIDER_KEY") ?? "byok";
    providers[CLOUDFLARE_AI_GATEWAY_PROVIDER_ID] = {
      npm: "@ai-sdk/openai-compatible",
      name: "Cloudflare AI Gateway",
      options: {
        baseURL: gatewayUrl,
        apiKey: providerKey,
        ...(gatewayToken
          ? { headers: { "cf-aig-authorization": `Bearer ${gatewayToken}` } }
          : {}),
      },
      models: modelsMap(cloudflareAiGatewayModelIds(resolve)),
    };
  }

  return providers;
}

/** True when `model` targets a built-in gateway that `opencode models` cannot list. */
export function isBuiltinGatewayModel(model: string, resolve: ResolveEnv): boolean {
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  const provider = model.slice(0, slash);
  return provider in builtinGatewayProviders(resolve, model);
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

async function listOllamaModelIds(resolve: ResolveEnv, fetchImpl: FetchLike): Promise<string[]> {
  try {
    const response = await fetchImpl(`${resolveOllamaBaseUrl(resolve)}/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Models for the hire flow's model picker. Never throws. */
export async function listBuiltinGatewayModels(
  resolve: ResolveEnv = (name) => process.env[name],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<AdapterModel[]> {
  const models: AdapterModel[] = [];
  const providers = builtinGatewayProviders(resolve);
  if (providers[CLOUDFLARE_AI_GATEWAY_PROVIDER_ID]) {
    for (const id of cloudflareAiGatewayModelIds(resolve)) {
      models.push({
        id: `${CLOUDFLARE_AI_GATEWAY_PROVIDER_ID}/${id}`,
        label: `Cloudflare AI Gateway · ${id}`,
      });
    }
  }
  if (providers[OLLAMA_PROVIDER_ID]) {
    const ids = new Set([
      ...splitList(envValue(resolve, "OLLAMA_MODELS")),
      ...(await listOllamaModelIds(resolve, fetchImpl)),
    ]);
    for (const id of ids) {
      models.push({ id: `${OLLAMA_PROVIDER_ID}/${id}`, label: `Ollama · ${id}` });
    }
  }
  return models;
}
