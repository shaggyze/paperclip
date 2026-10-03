import { describe, expect, it } from "vitest";
import { firstNonEmptyLine } from "./output-lines.js";

describe("firstNonEmptyLine", () => {
  const warning =
    'WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp"';

  it("skips the Codex PATH alias warning when a real error follows", () => {
    expect(firstNonEmptyLine(`\n${warning}\nError: ProviderModelNotFoundError openrouter/free\n`))
      .toBe("Error: ProviderModelNotFoundError openrouter/free");
  });

  it("falls back to the warning when it is the only line", () => {
    expect(firstNonEmptyLine(`${warning}\n`)).toBe(warning);
    expect(firstNonEmptyLine("  \n")).toBe("");
  });
});
