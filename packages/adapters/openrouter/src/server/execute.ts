import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  asBoolean,
  asString,
  asStringArray,
  buildPaperclipEnv,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  renderTemplate,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OPENROUTER_MAX_TURNS, DEFAULT_OPENROUTER_MODEL } from "../index.js";
import {
  OpenRouterHttpError,
  createChatCompletion,
  type OpenRouterMessage,
  type OpenRouterToolCall,
} from "./openrouter-client.js";
import { loadDesiredSkillMarkdown } from "./skills.js";
import { PAPERCLIP_TOOL_DEFINITIONS, PaperclipApiClient, runPaperclipTool } from "./tools.js";

/** Stops a run whose model calls the same tool with the same arguments this many times in a row. */
const REPEAT_CALL_LIMIT = 3;

export type OpenRouterEvent =
  | { type: "openrouter.init"; model: string; runId: string; tools: string[] }
  | { type: "openrouter.assistant"; text: string }
  | { type: "openrouter.thinking"; text: string }
  | { type: "openrouter.tool_call"; id: string; name: string; input: unknown }
  | { type: "openrouter.tool_result"; id: string; name: string; content: string; isError: boolean }
  | {
      type: "openrouter.result";
      subtype: string;
      text: string;
      isError: boolean;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
      turns: number;
      errors: string[];
    };

/** Reads a config env value stored as a plain string or a `{ type: "plain", value }` binding. */
export function readConfigEnvValue(config: Record<string, unknown>, key: string): string {
  const entry = parseObject(config.env)[key];
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const rec = entry as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") return rec.value.trim();
  }
  return "";
}

/** True when baseUrl is unset or points at openrouter.ai over https. */
export function usesOpenRouterHost(baseUrl: string): boolean {
  if (!baseUrl.trim()) return true;
  try {
    const url = new URL(baseUrl.trim());
    return url.protocol === "https:" && url.hostname === "openrouter.ai";
  } catch {
    return false;
  }
}

/**
 * The agent's own key always wins. The server-wide key is only used against
 * openrouter.ai so a custom baseUrl can never receive it.
 */
export function resolveOpenRouterApiKey(config: Record<string, unknown>): string {
  const agentKey = readConfigEnvValue(config, "OPENROUTER_API_KEY");
  if (agentKey) return agentKey;
  if (!usesOpenRouterHost(asString(config.baseUrl, ""))) return "";
  return (process.env.OPENROUTER_API_KEY ?? "").trim();
}

/** Accepts a string array or a newline/comma separated string (textarea form field). */
export function readModelList(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(/[\n,]/) : asStringArray(value);
  return raw.map((entry) => entry.trim()).filter(Boolean);
}

function readOptionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

class OpenRouterEmptyReplyError extends Error {}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function upstreamProvider(model: string): string | null {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : null;
}

function classifyHttpError(status: number): { errorCode: string; errorFamily: AdapterExecutionResult["errorFamily"] } {
  if (status === 401 || status === 403) return { errorCode: "openrouter_auth_failed", errorFamily: null };
  if (status === 402) return { errorCode: "openrouter_insufficient_credits", errorFamily: "provider_quota" };
  if (status === 429) return { errorCode: "openrouter_rate_limited", errorFamily: "provider_quota" };
  if (status >= 500) return { errorCode: "openrouter_upstream_error", errorFamily: "transient_upstream" };
  return { errorCode: "openrouter_request_failed", errorFamily: null };
}

async function readInstructionsFile(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<string> {
  const filePath = asString(config.instructionsFilePath, "").trim();
  if (!filePath) return "";
  try {
    const contents = (await fs.readFile(filePath, "utf8")).trim();
    return `${contents}\n\nThe above agent instructions were loaded from ${filePath}. Relative references resolve from ${path.dirname(filePath)}/.`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] Warning: could not read agent instructions file "${filePath}": ${reason}\n`);
    return "";
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, context, onLog, onMeta, authToken } = ctx;
  const config = parseObject(ctx.config);
  const model = asString(config.model, "").trim() || DEFAULT_OPENROUTER_MODEL;
  const fallbackModels = readModelList(config.fallbackModels);
  const maxTurns = Math.max(1, Math.floor(readOptionalNumber(config.maxTurns) ?? DEFAULT_OPENROUTER_MAX_TURNS));
  const timeoutSec = readOptionalNumber(config.timeoutSec) ?? 0;
  const timeoutMs = (timeoutSec > 0 ? timeoutSec : 120) * 1000;
  const temperature = readOptionalNumber(config.temperature);
  const maxTokens = readOptionalNumber(config.maxTokens);
  const baseUrl = asString(config.baseUrl, "");
  const injectSkills = asBoolean(config.injectSkills, true);
  const apiKey = resolveOpenRouterApiKey(config);

  const emit = (event: OpenRouterEvent) => onLog("stdout", `${JSON.stringify(event)}\n`);
  const baseResult = {
    signal: null,
    timedOut: false,
    provider: upstreamProvider(model),
    biller: "openrouter",
    billingType: "metered_api" as const,
    model,
  };

  if (!apiKey) {
    const message = "OPENROUTER_API_KEY is not set. Add it under this agent's environment variables or on the server.";
    await onLog("stderr", `[paperclip] ${message}\n`);
    return { ...baseResult, exitCode: 1, errorCode: "openrouter_api_key_missing", errorMessage: message };
  }

  const paperclipEnv = buildPaperclipEnv(agent);
  const api = authToken
    ? new PaperclipApiClient({ baseUrl: paperclipEnv.PAPERCLIP_API_URL, authToken, runId, signal: ctx.signal })
    : null;
  const tools = api ? PAPERCLIP_TOOL_DEFINITIONS : [];

  const instructions = await readInstructionsFile(config, onLog);
  const skills = injectSkills ? await loadDesiredSkillMarkdown(config) : [];
  const taskId = asString(context.taskId, "") || asString(context.issueId, "");
  const runtimeNote = [
    "## Paperclip runtime",
    `- Agent id: ${agent.id}`,
    `- Company id: ${agent.companyId}`,
    `- Run id: ${runId}`,
    taskId ? `- Current task id: ${taskId}` : "",
    api
      ? "- You have no shell. Act through the provided tools; they call the Paperclip API as you with the run id header already set. Where a skill shows curl or env vars such as $PAPERCLIP_API_KEY, use the matching tool or paperclip_api_request instead."
      : "- No Paperclip API token was issued for this run, so no tools are available. Reply with your result as plain text.",
    "- When the work for this heartbeat is finished, reply with a short final summary and no tool calls.",
  ].filter(Boolean).join("\n");
  const systemPrompt = joinPromptSections([
    instructions,
    ...skills.map((skill) => `# Skill: ${skill.key}\n\n${skill.markdown}`),
    runtimeNote,
  ]);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: false,
    includeCommunicationGuidance: false,
  });
  const renderedPrompt = isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(promptTemplate, templateData).trim();
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const userPrompt = joinPromptSections([
    selectInitialCommunicationGuidance(context, { resumedSession: false }),
    bootstrapPromptTemplate.trim() ? renderTemplate(bootstrapPromptTemplate, templateData).trim() : "",
    wakePrompt,
    taskContextNote,
    renderedPrompt,
    asString(context.paperclipSessionHandoffMarkdown, "").trim(),
  ]);

  if (onMeta) {
    await onMeta({
      adapterType: "openrouter",
      command: `POST ${baseUrl || "https://openrouter.ai/api/v1"}/chat/completions`,
      commandNotes: [
        `Model: ${model}${fallbackModels.length ? ` (fallbacks: ${fallbackModels.join(", ")})` : ""}`,
        `Max turns: ${maxTurns}`,
        `Skills injected: ${skills.length ? skills.map((skill) => skill.key).join(", ") : "none"}`,
        api ? `Paperclip tools: ${tools.length}` : "Paperclip tools: none (no run token)",
      ],
      prompt: userPrompt,
      promptMetrics: {
        promptChars: userPrompt.length,
        systemPromptChars: systemPrompt.length,
        instructionsChars: instructions.length,
        wakePromptChars: wakePrompt.length,
        taskContextChars: taskContextNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
    });
  }

  await ctx.onCancellationReady?.();
  ctx.onDispatch?.();
  await emit({ type: "openrouter.init", model, runId, tools: tools.map((tool) => tool.function.name) });

  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let servedModel = model;
  let finalText = "";
  let turns = 0;
  let toolCallCount = 0;
  let lastSignature = "";
  let repeatCount = 0;
  let stopReason: "completed" | "max_turns" | "repeat_loop" = "max_turns";

  const finish = async (
    subtype: string,
    isError: boolean,
    errors: string[],
    extra: Partial<AdapterExecutionResult> = {},
  ): Promise<AdapterExecutionResult> => {
    await emit({
      type: "openrouter.result",
      subtype,
      text: finalText,
      isError,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      turns,
      errors,
    });
    return {
      ...baseResult,
      provider: upstreamProvider(servedModel),
      model: servedModel,
      exitCode: isError ? 1 : 0,
      usage: { inputTokens, outputTokens, cachedInputTokens: cachedTokens },
      usageBasis: "per_run",
      costUsd,
      summary: firstNonEmptyLine(finalText) || null,
      resultJson: { stopReason: subtype, finalText, turns, toolCalls: toolCallCount },
      ...(errors.length ? { errorMessage: errors.join("; ") } : {}),
      ...extra,
    };
  };

  try {
    while (turns < maxTurns) {
      turns += 1;
      const completion = await createChatCompletion(
        { apiKey, baseUrl, timeoutMs, signal: ctx.signal },
        { model, messages, tools, fallbackModels, temperature, maxTokens },
      );
      if (completion.model) servedModel = completion.model;
      inputTokens += completion.usage?.prompt_tokens ?? 0;
      outputTokens += completion.usage?.completion_tokens ?? 0;
      cachedTokens += completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      costUsd += completion.usage?.cost ?? 0;

      const choice = completion.choices?.[0];
      const message = choice?.message ?? {};
      const finishReason = choice?.finish_reason ?? null;
      const reasoning = (message.reasoning ?? "").trim();
      if (reasoning) await emit({ type: "openrouter.thinking", text: reasoning });
      const text = (message.content ?? "").trim();
      if (text) {
        finalText = text;
        await emit({ type: "openrouter.assistant", text });
      }
      const toolCalls: OpenRouterToolCall[] = (message.tool_calls ?? []).filter(
        (call) => call?.type === "function" && typeof call.function?.name === "string",
      );
      if (toolCalls.length === 0 || !api) {
        if (!choice) throw new OpenRouterEmptyReplyError("OpenRouter returned no choices.");
        if (finishReason === "length" || finishReason === "error") {
          throw new OpenRouterEmptyReplyError(`The model stopped early (finish_reason: ${finishReason}).`);
        }
        if (!text) throw new OpenRouterEmptyReplyError("The model returned an empty reply with no tool calls.");
        stopReason = "completed";
        break;
      }

      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: toolCalls });
      let repeatTripped = false;
      for (const call of toolCalls) {
        toolCallCount += 1;
        const name = call.function.name;
        const signature = `${name}:${call.function.arguments}`;
        repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
        lastSignature = signature;
        let outcome: { ok: boolean; content: string };
        let input: unknown = call.function.arguments;
        try {
          const args = parseToolArguments(call.function.arguments);
          input = args;
          await emit({ type: "openrouter.tool_call", id: call.id, name, input });
          outcome = repeatCount >= REPEAT_CALL_LIMIT
            ? { ok: false, content: `Stopped: ${name} was called ${repeatCount} times in a row with identical arguments.` }
            : await runPaperclipTool(name, args, { api, agentId: agent.id, companyId: agent.companyId });
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          if (input === call.function.arguments) {
            await emit({ type: "openrouter.tool_call", id: call.id, name, input });
          }
          outcome = { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
        await emit({ type: "openrouter.tool_result", id: call.id, name, content: outcome.content, isError: !outcome.ok });
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
        if (repeatCount >= REPEAT_CALL_LIMIT) repeatTripped = true;
      }
      if (repeatTripped) {
        stopReason = "repeat_loop";
        break;
      }
    }
  } catch (err) {
    if (ctx.signal?.aborted) {
      return finish("cancelled", true, ["OpenRouter execution was cancelled"], { errorCode: "cancelled" });
    }
    if (err instanceof OpenRouterEmptyReplyError) {
      return finish("empty_reply", true, [err.message], { errorCode: "openrouter_empty_reply" });
    }
    if (err instanceof OpenRouterHttpError) {
      const { errorCode, errorFamily } = classifyHttpError(err.status);
      return finish("error", true, [err.message], { errorCode, errorFamily });
    }
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return finish("timeout", true, [`OpenRouter request timed out after ${timeoutMs}ms`], {
        timedOut: true,
        errorCode: "timeout",
      });
    }
    const reason = err instanceof Error ? err.message : String(err);
    return finish("error", true, [`OpenRouter request failed: ${reason}`], {
      errorCode: "openrouter_network_error",
      errorFamily: "transient_upstream",
    });
  }

  if (stopReason === "repeat_loop") {
    return finish("repeat_loop", true, ["Stopped a repeated identical tool call loop"], {
      errorCode: "openrouter_repeat_tool_loop",
    });
  }
  if (stopReason === "max_turns") {
    return finish("max_turns", true, [`Reached maxTurns (${maxTurns}) before the model finished`], {
      errorCode: "openrouter_max_turns",
    });
  }
  return finish("completed", false, []);
}
