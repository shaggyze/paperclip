import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, readModelList, resolveOpenRouterApiKey } from "./execute.js";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function completion(message: Record<string, unknown>, usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }) {
  return { id: "gen-1", model: "openai/gpt-4o-mini", choices: [{ message }], usage };
}

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}) {
  const stdout: string[] = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Bot", adapterType: "openrouter", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      model: "openai/gpt-4o-mini",
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      injectSkills: false,
      promptTemplate: "Do the work for {{agent.name}}.",
    },
    context: { taskId: "issue-1" },
    onLog: async (stream, chunk) => {
      if (stream === "stdout") stdout.push(chunk);
    },
    authToken: "run-jwt",
    ...overrides,
  } as AdapterExecutionContext;
  return { ctx, stdout };
}

function events(stdout: string[]) {
  return stdout.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openrouter execute", () => {
  it("runs a tool call against the Paperclip API and finishes on a text reply", async () => {
    const calls: FetchCall[] = [];
    const replies = [
      jsonResponse(completion({
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "add_comment", arguments: '{"issueId":"issue-1","body":"Done."}' } }],
      })),
      jsonResponse({ id: "comment-1", body: "Done." }, 201),
      jsonResponse(completion({ content: "Posted the update.\nMore detail." })),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return replies.shift()!;
    }));

    const { ctx, stdout } = makeCtx();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Posted the update.");
    expect(result.biller).toBe("openrouter");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 });
    expect(result.costUsd).toBeCloseTo(0.002);

    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-test");
    const firstBody = JSON.parse(String(calls[0].init.body));
    expect(firstBody.model).toBe("openai/gpt-4o-mini");
    expect(firstBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain("add_comment");

    expect(calls[1].url).toMatch(/\/api\/issues\/issue-1\/comments$/);
    const apiHeaders = calls[1].init.headers as Record<string, string>;
    expect(apiHeaders.authorization).toBe("Bearer run-jwt");
    expect(apiHeaders["x-paperclip-run-id"]).toBe("run-1");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ body: "Done." });

    const secondBody = JSON.parse(String(calls[2].init.body));
    expect(secondBody.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });

    const kinds = events(stdout).map((event) => event.type);
    expect(kinds).toEqual([
      "openrouter.init",
      "openrouter.tool_call",
      "openrouter.tool_result",
      "openrouter.assistant",
      "openrouter.result",
    ]);
  });

  it("fails without an API key and makes no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const { ctx } = makeCtx({ config: { model: "openai/gpt-4o-mini" } });
      const result = await execute(ctx);
      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("openrouter_api_key_missing");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("maps a 429 from OpenRouter to a provider quota error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "Rate limit exceeded" } }, 429)));
    const { ctx } = makeCtx();
    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openrouter_rate_limited");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.errorMessage).toContain("Rate limit exceeded");
  });

  it("stops a repeated identical tool call loop", async () => {
    const toolTurn = () => jsonResponse(completion({
      content: null,
      tool_calls: [{ id: "call", type: "function", function: { name: "get_issue", arguments: '{"issueId":"issue-1"}' } }],
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("openrouter.ai") ? toolTurn() : jsonResponse({ id: "issue-1" })));
    const { ctx } = makeCtx();
    const result = await execute(ctx);
    expect(result.errorCode).toBe("openrouter_repeat_tool_loop");
    expect(result.resultJson).toMatchObject({ turns: 3 });
  });

  it("rejects tool paths outside the Paperclip API", async () => {
    const replies = [
      jsonResponse(completion({
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "paperclip_api_request", arguments: '{"method":"GET","path":"https://evil.example/steal"}' },
        }],
      })),
      jsonResponse(completion({ content: "ok" })),
    ];
    const fetchMock = vi.fn(async () => replies.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, stdout } = makeCtx();
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const toolResult = events(stdout).find((event) => event.type === "openrouter.tool_result");
    expect(toolResult).toMatchObject({ isError: true });
    expect(String(toolResult?.content)).toContain("/api/");
  });

  it("sends fallback models from a textarea value", async () => {
    expect(readModelList("a/b\n c/d ,e/f")).toEqual(["a/b", "c/d", "e/f"]);
    const fetchMock = vi.fn(async () => jsonResponse(completion({ content: "hi" })));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    ctx.config.fallbackModels = "google/gemini-2.5-flash";
    await execute(ctx);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.models).toEqual(["openai/gpt-4o-mini", "google/gemini-2.5-flash"]);
  });

  it("never sends the server key to a custom baseUrl", () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    try {
      expect(resolveOpenRouterApiKey({})).toBe("sk-or-server");
      expect(resolveOpenRouterApiKey({ baseUrl: "https://openrouter.ai/api/v1" })).toBe("sk-or-server");
      expect(resolveOpenRouterApiKey({ baseUrl: "https://attacker.example/v1" })).toBe("");
      expect(resolveOpenRouterApiKey({ baseUrl: "http://openrouter.ai/api/v1" })).toBe("");
      expect(resolveOpenRouterApiKey({ baseUrl: "https://attacker.example/v1", env: { OPENROUTER_API_KEY: "sk-agent" } }))
        .toBe("sk-agent");
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("reports an empty or truncated reply as an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] })));
    const { ctx } = makeCtx();
    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openrouter_empty_reply");
  });

  it("returns a transient error and keeps usage when the network fails", async () => {
    const replies: Array<() => Promise<Response>> = [
      async () => jsonResponse(completion({
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "list_inbox", arguments: "{}" } }],
      })),
      async () => jsonResponse([]),
      async () => { throw new TypeError("fetch failed"); },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => replies.shift()!()));
    const { ctx, stdout } = makeCtx();
    const result = await execute(ctx);
    expect(result.errorCode).toBe("openrouter_network_error");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.usage?.inputTokens).toBe(10);
    expect(events(stdout).at(-1)).toMatchObject({ type: "openrouter.result", isError: true });
  });
});
