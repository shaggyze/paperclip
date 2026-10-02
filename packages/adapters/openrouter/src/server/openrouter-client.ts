import type { AdapterModel } from "@paperclipai/adapter-utils";
import { OPENROUTER_DEFAULT_BASE_URL } from "../index.js";
import type { OpenRouterToolDefinition } from "./tools.js";

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenRouterMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenRouterToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

export interface OpenRouterChoiceMessage {
  content?: string | null;
  reasoning?: string | null;
  tool_calls?: OpenRouterToolCall[];
}

export interface OpenRouterCompletion {
  id?: string;
  model?: string;
  choices?: Array<{ message?: OpenRouterChoiceMessage; finish_reason?: string | null }>;
  usage?: OpenRouterUsage;
  error?: { message?: string; code?: number | string };
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  tools?: OpenRouterToolDefinition[];
  fallbackModels?: string[];
  temperature?: number;
  maxTokens?: number;
}

export class OpenRouterHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenRouterHttpError";
  }
}

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function normalizeBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() || OPENROUTER_DEFAULT_BASE_URL;
  return value.replace(/\/+$/, "");
}

export async function createChatCompletion(
  options: OpenRouterClientOptions,
  request: OpenRouterRequest,
): Promise<OpenRouterCompletion> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    // Ask OpenRouter to return token counts and USD cost inline.
    usage: { include: true },
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  if (request.fallbackModels && request.fallbackModels.length > 0) {
    body.models = [request.model, ...request.fallbackModels];
  }
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.maxTokens === "number" && request.maxTokens > 0) body.max_tokens = request.maxTokens;

  const res = await fetchImpl(`${normalizeBaseUrl(options.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      "http-referer": "https://github.com/paperclipai/paperclip",
      "x-title": "Paperclip",
    },
    body: JSON.stringify(body),
    signal: withTimeout(options.signal, options.timeoutMs ?? 120_000),
  });
  const text = await res.text();
  let parsed: OpenRouterCompletion | null = null;
  try {
    parsed = text ? (JSON.parse(text) as OpenRouterCompletion) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const detail = parsed?.error?.message ?? text.slice(0, 500);
    throw new OpenRouterHttpError(res.status, `OpenRouter request failed (HTTP ${res.status}): ${detail}`);
  }
  if (!parsed) throw new OpenRouterHttpError(res.status, "OpenRouter returned an empty or invalid response.");
  // OpenRouter can report upstream failures inside a 200 response.
  if (parsed.error) {
    const status = typeof parsed.error.code === "number" ? parsed.error.code : 502;
    throw new OpenRouterHttpError(status, `OpenRouter upstream error: ${parsed.error.message ?? "unknown"}`);
  }
  return parsed;
}

export interface OpenRouterKeyInfo {
  label?: string;
  usage?: number;
  limit?: number | null;
  is_free_tier?: boolean;
}

export async function fetchKeyInfo(options: OpenRouterClientOptions): Promise<OpenRouterKeyInfo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${normalizeBaseUrl(options.baseUrl)}/key`, {
    headers: { authorization: `Bearer ${options.apiKey}` },
    signal: withTimeout(options.signal, options.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new OpenRouterHttpError(res.status, `OpenRouter key check failed (HTTP ${res.status}).`);
  const body = (await res.json()) as { data?: OpenRouterKeyInfo };
  return body.data ?? {};
}

let modelCache: { until: number; models: AdapterModel[] } | undefined;

/** Lists models from OpenRouter's public catalog; tool-capable models only. */
export async function listOpenRouterModels(fetchImpl: typeof fetch = fetch): Promise<AdapterModel[]> {
  if (modelCache && modelCache.until > Date.now()) return modelCache.models;
  const res = await fetchImpl(`${OPENROUTER_DEFAULT_BASE_URL}/models?supported_parameters=tools`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Could not load OpenRouter models (HTTP ${res.status}).`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
  const models = (body.data ?? [])
    .flatMap((model) =>
      typeof model.id === "string" && model.id.includes("/")
        ? [{ id: model.id, label: typeof model.name === "string" ? model.name : model.id }]
        : [],
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  modelCache = { until: Date.now() + 5 * 60_000, models };
  return models;
}
