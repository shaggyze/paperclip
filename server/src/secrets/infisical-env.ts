import { readFile } from "node:fs/promises";

/**
 * Pulls AI provider keys from Infisical into process.env at server start.
 *
 * Authentication, first match wins:
 * 1. INFISICAL_TOKEN: an access token.
 * 2. INFISICAL_TOKEN_FILE: the sink file the Infisical Agent keeps fresh.
 * 3. INFISICAL_UNIVERSAL_AUTH_CLIENT_ID + INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:
 *    a machine identity login.
 *
 * INFISICAL_PROJECT_ID selects the project. INFISICAL_ENVIRONMENT (default
 * "prod") and INFISICAL_SECRET_PATH (default "/") select the folder.
 * INFISICAL_API_URL (or INFISICAL_DOMAIN) points at a self-hosted instance or
 * a local proxy. INFISICAL_SECRET_KEYS overrides the default key allowlist;
 * "*" imports every key. Values already present in the environment win, so a
 * local .env can still override one key. Secret values never reach the log.
 */
export const DEFAULT_INFISICAL_SECRET_KEYS = [
  "OPENROUTER_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AI_GATEWAY_ID",
  "CLOUDFLARE_AI_GATEWAY_URL",
  "CLOUDFLARE_AI_GATEWAY_TOKEN",
  "CLOUDFLARE_AI_GATEWAY_PROVIDER_KEY",
  "CLOUDFLARE_AI_GATEWAY_MODELS",
  "OLLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_MODELS",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "FIRECRAWL_API_KEY",
] as const;

const DEFAULT_INFISICAL_API_URL = "https://app.infisical.com";
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface InfisicalEnvResult {
  status: "disabled" | "loaded" | "failed";
  /** Names of keys written to the environment. Never values. */
  loadedKeys: string[];
  message: string;
}

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? raw : null;
}

function apiBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = value(env, "INFISICAL_API_URL") ?? value(env, "INFISICAL_DOMAIN") ?? DEFAULT_INFISICAL_API_URL;
  return raw.replace(/\/+$/, "").replace(/\/api$/, "");
}

function allowlist(env: NodeJS.ProcessEnv): Set<string> | "all" {
  const raw = value(env, "INFISICAL_SECRET_KEYS");
  if (!raw) return new Set(DEFAULT_INFISICAL_SECRET_KEYS);
  if (raw === "*") return "all";
  return new Set(raw.split(/[\s,]+/).filter(Boolean));
}

async function accessToken(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const direct = value(env, "INFISICAL_TOKEN");
  if (direct) return direct;
  const tokenFile = value(env, "INFISICAL_TOKEN_FILE");
  if (tokenFile) {
    const fromFile = (await readFile(tokenFile, "utf8")).trim();
    if (fromFile) return fromFile;
  }
  const clientId = value(env, "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID");
  const clientSecret = value(env, "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  const response = await fetchImpl(`${baseUrl}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Infisical login returned HTTP ${response.status}`);
  const body = (await response.json()) as { accessToken?: unknown };
  if (typeof body.accessToken !== "string" || !body.accessToken) {
    throw new Error("Infisical login returned no access token");
  }
  return body.accessToken;
}

function hasCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    value(env, "INFISICAL_TOKEN") ||
      value(env, "INFISICAL_TOKEN_FILE") ||
      (value(env, "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID") &&
        value(env, "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET")),
  );
}

export async function loadInfisicalSecretsIntoEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<InfisicalEnvResult> {
  const projectId = value(env, "INFISICAL_PROJECT_ID");
  if (!projectId || !hasCredentials(env)) {
    return { status: "disabled", loadedKeys: [], message: "Infisical is not configured." };
  }
  try {
    const baseUrl = apiBaseUrl(env);
    const token = await accessToken(env, baseUrl, fetchImpl);
    if (!token) throw new Error("Infisical token file is empty");
    const query = new URLSearchParams({
      workspaceId: projectId,
      environment: value(env, "INFISICAL_ENVIRONMENT") ?? "prod",
      secretPath: value(env, "INFISICAL_SECRET_PATH") ?? "/",
      expandSecretReferences: "true",
    });
    const response = await fetchImpl(`${baseUrl}/api/v3/secrets/raw?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Infisical secrets request returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      secrets?: Array<{ secretKey?: unknown; secretValue?: unknown }>;
    };
    const allowed = allowlist(env);
    const loadedKeys: string[] = [];
    for (const secret of body.secrets ?? []) {
      if (typeof secret.secretKey !== "string" || typeof secret.secretValue !== "string") continue;
      if (allowed !== "all" && !allowed.has(secret.secretKey)) continue;
      if (value(env, secret.secretKey) !== null) continue;
      env[secret.secretKey] = secret.secretValue;
      loadedKeys.push(secret.secretKey);
    }
    return {
      status: "loaded",
      loadedKeys,
      message: `Loaded ${loadedKeys.length} secret(s) from Infisical.`,
    };
  } catch (error) {
    // Error text comes from our own messages or fetch; it never holds a value.
    return {
      status: "failed",
      loadedKeys: [],
      message: `Infisical secrets were not loaded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
