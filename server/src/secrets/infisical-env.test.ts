import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadInfisicalSecretsIntoEnv } from "./infisical-env.js";

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function fakeFetch(secrets: Array<{ secretKey: string; secretValue: string }>, calls: Call[], loginStatus = 200) {
  return async (url: string, init?: Call["init"]) => {
    calls.push({ url, init });
    if (url.endsWith("/api/v1/auth/universal-auth/login")) {
      return { ok: loginStatus === 200, status: loginStatus, json: async () => ({ accessToken: "access-1" }) };
    }
    return { ok: true, status: 200, json: async () => ({ secrets }) };
  };
}

const secrets = [
  { secretKey: "OPENROUTER_API_KEY", secretValue: "or-value" },
  { secretKey: "CLOUDFLARE_AI_GATEWAY_TOKEN", secretValue: "cf-value" },
  { secretKey: "OLLAMA_BASE_URL", secretValue: "http://hznpve:11434" },
  { secretKey: "UNRELATED_DB_PASSWORD", secretValue: "db-value" },
];

describe("loadInfisicalSecretsIntoEnv", () => {
  it("is disabled without a project id or credentials", async () => {
    const calls: Call[] = [];
    const env: NodeJS.ProcessEnv = { INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "id" };
    const result = await loadInfisicalSecretsIntoEnv(env, fakeFetch(secrets, calls));
    expect(result.status).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("logs in with universal auth and loads allowlisted keys only", async () => {
    const calls: Call[] = [];
    const env: NodeJS.ProcessEnv = {
      INFISICAL_PROJECT_ID: "proj",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "id",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "secret",
      INFISICAL_DOMAIN: "https://infisical.hznpve.local/api",
      OPENROUTER_API_KEY: "already-set",
    };
    const result = await loadInfisicalSecretsIntoEnv(env, fakeFetch(secrets, calls));
    expect(result.status).toBe("loaded");
    expect(result.loadedKeys).toEqual(["CLOUDFLARE_AI_GATEWAY_TOKEN", "OLLAMA_BASE_URL"]);
    expect(env.OPENROUTER_API_KEY).toBe("already-set");
    expect(env.CLOUDFLARE_AI_GATEWAY_TOKEN).toBe("cf-value");
    expect(env.UNRELATED_DB_PASSWORD).toBeUndefined();
    expect(calls[0].url).toBe("https://infisical.hznpve.local/api/v1/auth/universal-auth/login");
    expect(calls[1].url).toContain("/api/v3/secrets/raw?workspaceId=proj&environment=prod&secretPath=%2F");
    expect(calls[1].init?.headers?.Authorization).toBe("Bearer access-1");
    expect(result.message).not.toContain("cf-value");
  });

  it("reads the Infisical Agent token file and honors a wildcard allowlist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infisical-test-"));
    const tokenFile = path.join(dir, "token");
    await fs.writeFile(tokenFile, "agent-token\n");
    const calls: Call[] = [];
    const env: NodeJS.ProcessEnv = {
      INFISICAL_PROJECT_ID: "proj",
      INFISICAL_TOKEN_FILE: tokenFile,
      INFISICAL_SECRET_KEYS: "*",
    };
    try {
      const result = await loadInfisicalSecretsIntoEnv(env, fakeFetch(secrets, calls));
      expect(result.loadedKeys).toHaveLength(4);
      expect(calls).toHaveLength(1);
      expect(calls[0].url.startsWith("https://app.infisical.com/api/v3/secrets/raw?")).toBe(true);
      expect(calls[0].init?.headers?.Authorization).toBe("Bearer agent-token");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fails soft on a rejected login without leaking the client secret", async () => {
    const env: NodeJS.ProcessEnv = {
      INFISICAL_PROJECT_ID: "proj",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "id",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "super-secret",
    };
    const result = await loadInfisicalSecretsIntoEnv(env, fakeFetch(secrets, [], 401));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("HTTP 401");
    expect(result.message).not.toContain("super-secret");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });
});
