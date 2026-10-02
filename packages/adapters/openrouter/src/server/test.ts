import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OPENROUTER_MODEL } from "../index.js";
import { resolveOpenRouterApiKey } from "./execute.js";
import { fetchKeyInfo, listOpenRouterModels } from "./openrouter-client.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const apiKey = resolveOpenRouterApiKey(config);
  const model = asString(config.model, "").trim() || DEFAULT_OPENROUTER_MODEL;
  const baseUrl = asString(config.baseUrl, "");

  if (!apiKey) {
    checks.push({
      code: "openrouter_api_key_missing",
      level: "error",
      message: "OPENROUTER_API_KEY is required.",
      hint: "Create a key at https://openrouter.ai/keys and add it under this agent's environment variables.",
    });
  } else {
    try {
      const info = await fetchKeyInfo({ apiKey, baseUrl });
      const limit = typeof info.limit === "number" ? `$${info.limit}` : "no limit";
      checks.push({
        code: "openrouter_auth_ok",
        level: "info",
        message: "OpenRouter API key is valid.",
        detail: `Usage $${(info.usage ?? 0).toFixed(4)}, limit ${limit}${info.is_free_tier ? ", free tier (50 free-model requests per day)" : ""}.`,
      });
    } catch (err) {
      checks.push({
        code: "openrouter_auth_failed",
        level: "error",
        message: err instanceof Error ? err.message : "Failed to validate the OpenRouter API key.",
      });
    }
  }

  // Custom OpenAI-compatible endpoints have their own catalogs; only check OpenRouter's.
  if (!baseUrl.trim()) {
    try {
      const models = await listOpenRouterModels();
      const known = model === "openrouter/auto" || models.some((entry) => entry.id === model);
      checks.push({
        code: known ? "openrouter_model_ok" : "openrouter_model_unknown",
        level: known ? "info" : "warn",
        message: known
          ? `Model "${model}" supports tool calling on OpenRouter.`
          : `Model "${model}" is not in OpenRouter's tool-capable model list. Paperclip tools may not work.`,
      });
    } catch (err) {
      checks.push({
        code: "openrouter_model_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Failed to load the OpenRouter model list.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
