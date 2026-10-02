import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { DEFAULT_OPENROUTER_MAX_TURNS } from "../index.js";

export { execute, resolveOpenRouterApiKey } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listOpenRouterModels } from "./openrouter-client.js";
export { listOpenRouterSkills, syncOpenRouterSkills } from "./skills.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "maxTurns",
        label: "Max tool turns",
        type: "number",
        default: DEFAULT_OPENROUTER_MAX_TURNS,
        hint: "Maximum model calls per heartbeat before the run stops.",
      },
      {
        key: "fallbackModels",
        label: "Fallback models",
        type: "textarea",
        hint: "Optional OpenRouter model ids, one per line, tried when the primary model fails.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        hint: "Optional sampling temperature.",
      },
      {
        key: "injectSkills",
        label: "Inject skills",
        type: "toggle",
        default: true,
        hint: "Add assigned skills, including the Paperclip API skill, to the system prompt.",
      },
    ],
  };
}
