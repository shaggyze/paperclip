import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtinGatewayProviders,
  isBuiltinGatewayModel,
  listBuiltinGatewayModels,
  resolveOllamaBaseUrl,
} from "./gateway-providers.js";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const envOf = (env: Record<string, string>) => (name: string) => env[name];

describe("builtinGatewayProviders", () => {
  it("returns nothing when no gateway is configured", () => {
    expect(builtinGatewayProviders(envOf({}))).toEqual({});
    expect(builtinGatewayProviders(envOf({}), "openrouter/x")).toEqual({});
  });

  it("adds Ollama at the default URL when the model targets it", () => {
    const providers = builtinGatewayProviders(envOf({}), "ollama/qwen3:8b");
    expect(providers.ollama).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://localhost:11434/v1", apiKey: "ollama" },
    });
  });

  it("normalizes OLLAMA_BASE_URL and OLLAMA_HOST to a /v1 URL", () => {
    expect(resolveOllamaBaseUrl(envOf({ OLLAMA_BASE_URL: "http://hznpve:11434/" }))).toBe(
      "http://hznpve:11434/v1",
    );
    expect(resolveOllamaBaseUrl(envOf({ OLLAMA_HOST: "10.0.0.5:11434" }))).toBe(
      "http://10.0.0.5:11434/v1",
    );
    expect(resolveOllamaBaseUrl(envOf({ OLLAMA_BASE_URL: "http://a:1/v1" }))).toBe("http://a:1/v1");
  });

  it("builds the Cloudflare AI Gateway compat URL with the gateway auth header", () => {
    const providers = builtinGatewayProviders(
      envOf({
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_AI_GATEWAY_ID: "paperclip",
        CLOUDFLARE_AI_GATEWAY_TOKEN: "cf-token",
        CLOUDFLARE_AI_GATEWAY_MODELS: "dynamic/free-agents, workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      }),
    );
    expect(providers["cf-aig"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Cloudflare AI Gateway",
      options: {
        baseURL: "https://gateway.ai.cloudflare.com/v1/acct/paperclip/compat",
        apiKey: "byok",
        headers: { "cf-aig-authorization": "Bearer cf-token" },
      },
      models: {
        "dynamic/free-agents": { name: "dynamic/free-agents" },
        "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
          name: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        },
      },
    });
  });

  it("needs both account and gateway ids for Cloudflare", () => {
    expect(builtinGatewayProviders(envOf({ CLOUDFLARE_ACCOUNT_ID: "acct" }))).toEqual({});
  });

  it("marks only active gateway models as built in", () => {
    const env = envOf({ CLOUDFLARE_AI_GATEWAY_URL: "https://gw.example/compat/" });
    expect(isBuiltinGatewayModel("cf-aig/dynamic/free-agents", env)).toBe(true);
    expect(isBuiltinGatewayModel("ollama/llama3", env)).toBe(true);
    expect(isBuiltinGatewayModel("cf-aig/dynamic/free-agents", envOf({}))).toBe(false);
    expect(isBuiltinGatewayModel("openrouter/openrouter/free", env)).toBe(false);
  });
});

describe("listBuiltinGatewayModels", () => {
  it("lists gateway routes and installed Ollama models", async () => {
    const fetchImpl = async (url: string) => {
      expect(url).toBe("http://localhost:11434/v1/models");
      return { ok: true, json: async () => ({ data: [{ id: "qwen3:8b" }, { id: "llama3.2" }] }) };
    };
    const models = await listBuiltinGatewayModels(
      envOf({
        OLLAMA_BASE_URL: "http://localhost:11434",
        CLOUDFLARE_AI_GATEWAY_URL: "https://gw.example/compat",
      }),
      fetchImpl,
    );
    expect(models.map((m) => m.id)).toEqual([
      "cf-aig/dynamic/free-agents",
      "ollama/qwen3:8b",
      "ollama/llama3.2",
    ]);
  });

  it("returns an empty list when Ollama is unreachable", async () => {
    const models = await listBuiltinGatewayModels(
      envOf({ OLLAMA_BASE_URL: "http://localhost:1" }),
      async () => {
        throw new Error("ECONNREFUSED");
      },
    );
    expect(models).toEqual([]);
  });
});

describe("prepareOpenCodeRuntimeConfig built-in gateways", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
  });

  async function configHome(config: Record<string, unknown>) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gw-test-"));
    cleanup.push(home);
    await fs.mkdir(path.join(home, "opencode"), { recursive: true });
    await fs.writeFile(path.join(home, "opencode", "opencode.json"), JSON.stringify(config));
    return home;
  }

  async function readRuntime(env: Record<string, string>) {
    return JSON.parse(
      await fs.readFile(path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: Record<string, { options?: Record<string, unknown>; models?: Record<string, unknown> }> };
  }

  it("injects Ollama and Cloudflare providers and registers the model", async () => {
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: await configHome({}),
        CLOUDFLARE_AI_GATEWAY_URL: "https://gw.example/compat",
        OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      },
      config: { model: "cf-aig/dynamic/free-agents" },
    });
    cleanup.push(prepared.env.XDG_CONFIG_HOME);
    const runtime = await readRuntime(prepared.env);
    expect(runtime.provider["cf-aig"].options?.baseURL).toBe("https://gw.example/compat");
    expect(runtime.provider["cf-aig"].models).toHaveProperty(["dynamic/free-agents"]);
    expect(runtime.provider.ollama.options?.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(prepared.notes.some((n) => n.includes("cf-aig, ollama") || n.includes("ollama, cf-aig"))).toBe(true);
  });

  it("keeps a user-defined ollama provider over the built-in one", async () => {
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: await configHome({
          provider: { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://custom:1/v1" } } },
        }),
        OLLAMA_BASE_URL: "http://ignored:11434",
      },
      config: { model: "ollama/llama3.2" },
    });
    cleanup.push(prepared.env.XDG_CONFIG_HOME);
    const runtime = await readRuntime(prepared.env);
    expect(runtime.provider.ollama.options?.baseURL).toBe("http://custom:1/v1");
    expect(runtime.provider.ollama.models).toHaveProperty(["llama3.2"]);
  });
});

describe("ensureOpenCodeModelConfiguredAndAvailable with built-in gateways", () => {
  it("skips the probe only when the runtime config defines the provider", async () => {
    const { ensureOpenCodeModelConfiguredAndAvailable } = await import("./models.js");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gw-probe-"));
    try {
      await fs.mkdir(path.join(home, "opencode"), { recursive: true });
      await fs.writeFile(
        path.join(home, "opencode", "opencode.json"),
        JSON.stringify({ provider: { ollama: { models: {} } } }),
      );
      await expect(
        ensureOpenCodeModelConfiguredAndAvailable({
          model: "ollama/llama3.2",
          command: "/nonexistent/opencode",
          env: { XDG_CONFIG_HOME: home },
        }),
      ).resolves.toEqual([{ id: "ollama/llama3.2", label: "ollama/llama3.2" }]);
      // Without the runtime config the real probe runs; a missing binary only warns.
      const warn = console.warn;
      let warned = "";
      console.warn = (message: string) => { warned = message; };
      try {
        await ensureOpenCodeModelConfiguredAndAvailable({
          model: "ollama/llama3.2",
          command: "/nonexistent/opencode",
          env: {},
        });
      } finally {
        console.warn = warn;
      }
      expect(warned).toContain("probe could not run");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
