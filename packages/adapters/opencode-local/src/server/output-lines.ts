/**
 * Codex-based provider plugins print this warning on every run when their
 * home is under the OS temp dir. It is harmless and hides the real error.
 */
const BENIGN_WARNING_RE = /^WARNING: proceeding, even though we could not create PATH aliases/i;

/** First non-empty line, skipping known benign warnings when another line exists. */
export function firstNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !BENIGN_WARNING_RE.test(line)) ?? lines[0] ?? "";
}
