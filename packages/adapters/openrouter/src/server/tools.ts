export interface OpenRouterToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface PaperclipApiClientOptions {
  baseUrl: string;
  authToken: string;
  runId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Run cancellation; aborts in-flight tool requests. */
  signal?: AbortSignal;
}

export interface ToolCallOutcome {
  ok: boolean;
  content: string;
}

const MAX_TOOL_RESULT_CHARS = 24_000;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required string argument "${key}"`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

/** Paperclip API client authenticated as the agent for one run. */
export class PaperclipApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PaperclipApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(method: string, path: string, body?: unknown): Promise<ToolCallOutcome> {
    const normalizedMethod = method.trim().toUpperCase();
    if (!ALLOWED_METHODS.has(normalizedMethod)) {
      throw new Error(`Unsupported HTTP method "${method}"`);
    }
    // Only relative Paperclip API paths: the token must never leave this host.
    if (!path.startsWith("/api/") || path.includes("..") || /^\/\//.test(path)) {
      throw new Error(`Path must be a Paperclip API path starting with /api/ (got "${path}")`);
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.authToken}`,
      "x-paperclip-run-id": this.options.runId,
      accept: "application/json",
    };
    const init: RequestInit = { method: normalizedMethod, headers };
    if (body !== undefined && normalizedMethod !== "GET") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    init.signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, content: truncate(`HTTP ${res.status} ${normalizedMethod} ${path}: ${text}`) };
    }
    if (normalizedMethod !== "GET" && text.trim().length === 0) {
      return { ok: false, content: `HTTP ${res.status} ${normalizedMethod} ${path} returned an empty body; treat the write as unconfirmed.` };
    }
    return { ok: true, content: truncate(text || `HTTP ${res.status}`) };
  }
}

export const PAPERCLIP_TOOL_DEFINITIONS: OpenRouterToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_inbox",
      description: "List the issues assigned to you (compact inbox).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_issue",
      description: "Get compact heartbeat context for an issue: state, ancestors, goal, project and comment cursor.",
      parameters: {
        type: "object",
        properties: { issueId: { type: "string", description: "Issue id or identifier such as PAP-12" } },
        required: ["issueId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_comments",
      description: "List comments on an issue. Without after, returns the newest 20 comments newest first. With after, returns comments after that id oldest first.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          after: { type: "string", description: "Only comments after this comment id" },
        },
        required: ["issueId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "checkout_issue",
      description: "Check out an issue before working on it. A 409 means another agent owns it: stop and never retry.",
      parameters: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_comment",
      description: "Post a markdown comment on an issue.",
      parameters: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_issue",
      description: "Update an issue's status and optionally add a comment in the same write.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          status: {
            type: "string",
            enum: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"],
          },
          comment: { type: "string" },
        },
        required: ["issueId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_sub_issue",
      description: "Create a child issue under a parent issue, optionally assigned to another agent.",
      parameters: {
        type: "object",
        properties: {
          parentId: { type: "string", description: "Parent issue UUID (identifiers such as PAP-12 are rejected)" },
          title: { type: "string" },
          description: { type: "string" },
          assigneeAgentId: { type: "string" },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
        },
        required: ["parentId", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_api_request",
      description:
        "Call any other Paperclip API endpoint as yourself (documents, interactions, approvals, agents). Path must start with /api/.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", description: "Relative path such as /api/issues/{id}/documents/plan" },
          body: { type: "object", description: "JSON body for write requests" },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
    },
  },
];

export interface PaperclipToolContext {
  api: PaperclipApiClient;
  agentId: string;
  companyId: string;
}

export async function runPaperclipTool(
  name: string,
  args: Record<string, unknown>,
  ctx: PaperclipToolContext,
): Promise<ToolCallOutcome> {
  const { api } = ctx;
  switch (name) {
    case "list_inbox":
      return api.request("GET", "/api/agents/me/inbox-lite");
    case "get_issue":
      return api.request("GET", `/api/issues/${encodeId(requireString(args, "issueId"))}/heartbeat-context`);
    case "list_comments": {
      const issueId = encodeId(requireString(args, "issueId"));
      const after = optionalString(args, "after");
      const query = after ? `?after=${encodeURIComponent(after)}&order=asc` : "?order=desc&limit=20";
      return api.request("GET", `/api/issues/${issueId}/comments${query}`);
    }
    case "checkout_issue":
      return api.request("POST", `/api/issues/${encodeId(requireString(args, "issueId"))}/checkout`, {
        agentId: ctx.agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });
    case "add_comment":
      return api.request("POST", `/api/issues/${encodeId(requireString(args, "issueId"))}/comments`, {
        body: requireString(args, "body"),
      });
    case "update_issue": {
      const issueId = encodeId(requireString(args, "issueId"));
      const patch: Record<string, unknown> = {};
      const status = optionalString(args, "status");
      const comment = optionalString(args, "comment");
      if (status) patch.status = status;
      if (comment) patch.comment = comment;
      if (Object.keys(patch).length === 0) throw new Error("update_issue needs status or comment");
      return api.request("PATCH", `/api/issues/${issueId}`, patch);
    }
    case "create_sub_issue": {
      const body: Record<string, unknown> = {
        parentId: requireString(args, "parentId"),
        title: requireString(args, "title"),
      };
      for (const key of ["description", "assigneeAgentId", "priority"]) {
        const value = optionalString(args, key);
        if (value) body[key] = value;
      }
      return api.request("POST", `/api/companies/${encodeId(ctx.companyId)}/issues`, body);
    }
    case "paperclip_api_request": {
      const body = args.body;
      return api.request(
        requireString(args, "method"),
        requireString(args, "path"),
        typeof body === "object" && body !== null ? body : undefined,
      );
    }
    default:
      return { ok: false, content: `Unknown tool "${name}"` };
  }
}
