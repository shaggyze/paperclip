import { describe, expect, it } from "vitest";
import { parseOpenRouterStdoutLine } from "./parse-stdout.js";

const ts = "2026-10-02T00:00:00.000Z";

describe("parseOpenRouterStdoutLine", () => {
  it("maps adapter events to transcript entries", () => {
    expect(parseOpenRouterStdoutLine(JSON.stringify({ type: "openrouter.init", model: "m", runId: "r" }), ts))
      .toEqual([{ kind: "init", ts, model: "m", sessionId: "r" }]);
    expect(parseOpenRouterStdoutLine(JSON.stringify({ type: "openrouter.tool_call", id: "c", name: "get_issue", input: { issueId: "i" } }), ts))
      .toEqual([{ kind: "tool_call", ts, name: "get_issue", input: { issueId: "i" }, toolUseId: "c" }]);
    expect(parseOpenRouterStdoutLine(JSON.stringify({ type: "openrouter.tool_result", id: "c", name: "get_issue", content: "x", isError: true }), ts))
      .toEqual([{ kind: "tool_result", ts, toolUseId: "c", toolName: "get_issue", content: "x", isError: true }]);
    const [result] = parseOpenRouterStdoutLine(JSON.stringify({
      type: "openrouter.result", subtype: "completed", text: "done", isError: false,
      inputTokens: 3, outputTokens: 2, cachedTokens: 0, costUsd: 0.01, errors: [],
    }), ts);
    expect(result).toMatchObject({ kind: "result", text: "done", costUsd: 0.01, subtype: "completed" });
  });

  it("keeps non-JSON lines as stdout", () => {
    expect(parseOpenRouterStdoutLine("plain text", ts)).toEqual([{ kind: "stdout", ts, text: "plain text" }]);
    expect(parseOpenRouterStdoutLine("   ", ts)).toEqual([]);
  });
});
