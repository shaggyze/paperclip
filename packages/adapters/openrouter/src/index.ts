export const type = "openrouter";
export const label = "OpenRouter";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
// Free, verified to call tools reliably. Paid models give better tool use.
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-oss-120b:free";
export const DEFAULT_OPENROUTER_MAX_TURNS = 20;

export const models = [
  { id: DEFAULT_OPENROUTER_MODEL, label: "gpt-oss-120b (free)" },
  { id: "openrouter/auto", label: "OpenRouter Auto router" },
  { id: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini" },
  { id: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5" },
  { id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash" },
  { id: "deepseek/deepseek-chat-v3.1", label: "DeepSeek V3.1" },
  { id: "qwen/qwen3-coder", label: "Qwen3 Coder" },
];

export const agentConfigurationDoc = `# openrouter agent configuration

Adapter: openrouter

Use when:
- You want an agent that runs on any of the 300+ OpenRouter models (free or paid) with one API key
- You do not need a local CLI harness or shell access; the agent works through the Paperclip API

How it works:
- Each heartbeat runs a tool-calling loop against OpenRouter chat completions.
- The adapter executes Paperclip API tools (issues, comments, checkout, sub-issues, generic API requests)
  as the agent, with the run-scoped token and X-Paperclip-Run-Id header.
- Assigned Paperclip skills are injected into the system prompt.
- The loop stops when the model replies without tool calls or after maxTurns.

Core fields:
- model (string, optional): OpenRouter model id, default ${DEFAULT_OPENROUTER_MODEL}. Use ":free" ids for free models, "openrouter/auto" for auto routing.
- fallbackModels (string[], optional): extra model ids OpenRouter tries when the primary model fails
- maxTurns (number, optional): tool-loop turn cap, default ${DEFAULT_OPENROUTER_MAX_TURNS}
- temperature (number, optional): sampling temperature
- maxTokens (number, optional): max output tokens per completion
- timeoutSec (number, optional): per-request timeout in seconds, default 120
- baseUrl (string, optional): OpenAI-compatible base URL, default ${OPENROUTER_DEFAULT_BASE_URL}
- injectSkills (boolean, optional): inject assigned skills into the system prompt, default true
- instructionsFilePath (string, optional): agent instructions file prepended to the system prompt
- promptTemplate (string, optional): heartbeat prompt template
- env.OPENROUTER_API_KEY (string, required unless set on the server): OpenRouter API key
`;
