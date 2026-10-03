import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildSnapshot(config: Record<string, unknown>, adapterType: string): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  return buildRuntimeMountedSkillSnapshot({
    adapterType,
    availableEntries,
    desiredSkills: resolveLegacyPaperclipDesiredSkillNames(config, availableEntries),
    configuredDetail: "Injected into the OpenRouter system prompt on the next run.",
  });
}

export async function listOpenRouterSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config, ctx.adapterType);
}

export async function syncOpenRouterSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildSnapshot(ctx.config, ctx.adapterType);
}

export interface LoadedSkill {
  key: string;
  markdown: string;
}

/** Reads SKILL.md for each desired skill; the operational Paperclip skill comes first. */
export async function loadDesiredSkillMarkdown(config: Record<string, unknown>): Promise<LoadedSkill[]> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desired = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const loaded: LoadedSkill[] = [];
  for (const key of desired) {
    const entry = availableEntries.find((candidate) => candidate.key === key);
    if (!entry || entry.sourceStatus === "missing") continue;
    try {
      const markdown = await fs.readFile(path.join(entry.source, "SKILL.md"), "utf8");
      if (markdown.trim()) loaded.push({ key, markdown: markdown.trim() });
    } catch {
      // A missing SKILL.md is reported by the skill snapshot; skip it here.
    }
  }
  return loaded;
}
