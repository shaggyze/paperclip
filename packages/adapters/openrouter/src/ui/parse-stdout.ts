import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseOpenRouterStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let event: Record<string, unknown> | null = null;
  try {
    event = asRecord(JSON.parse(trimmed));
  } catch {
    event = null;
  }
  if (!event) return [{ kind: "stdout", ts, text: line }];

  switch (str(event.type)) {
    case "openrouter.init":
      return [{ kind: "init", ts, model: str(event.model), sessionId: str(event.runId) }];
    case "openrouter.assistant":
      return [{ kind: "assistant", ts, text: str(event.text) }];
    case "openrouter.thinking":
      return [{ kind: "thinking", ts, text: str(event.text) }];
    case "openrouter.tool_call":
      return [{ kind: "tool_call", ts, name: str(event.name) || "tool", input: event.input ?? {}, toolUseId: str(event.id) || undefined }];
    case "openrouter.tool_result":
      return [{
        kind: "tool_result",
        ts,
        toolUseId: str(event.id),
        toolName: str(event.name) || undefined,
        content: str(event.content),
        isError: event.isError === true,
      }];
    case "openrouter.result":
      return [{
        kind: "result",
        ts,
        text: str(event.text),
        inputTokens: num(event.inputTokens),
        outputTokens: num(event.outputTokens),
        cachedTokens: num(event.cachedTokens),
        costUsd: num(event.costUsd),
        subtype: str(event.subtype),
        isError: event.isError === true,
        errors: Array.isArray(event.errors) ? event.errors.filter((entry): entry is string => typeof entry === "string") : [],
      }];
    default:
      return [{ kind: "stdout", ts, text: line }];
  }
}
