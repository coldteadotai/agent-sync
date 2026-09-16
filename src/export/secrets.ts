// Export-time secret content scanning: the last hole in the leak story.
// Credential FILENAMES are refused structurally, but a token pasted inside a
// SKILL.md would ship silently without this. Findings never carry the matched
// value — path, line and kind only (the content-free diagnostics rule).

export interface SecretFinding {
  line: number;
  kind: string;
}

const TOKEN_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  { kind: "API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: "GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { kind: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/ },
];

// The entropy detector is deliberately conservative: it exists to catch a
// pasted random credential the prefix table does not know, not to flag every
// hash. Hex digests (~4 bits/char) stay under the threshold; random base64
// (~6 bits/char) clears it.
const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{40,}/g;
const ENTROPY_THRESHOLD = 4.8;

export function scanContentForSecrets(content: Buffer): SecretFinding[] {
  if (content.includes(0)) return [];
  const findings: SecretFinding[] = [];
  const lines = content.toString("utf8").split("\n");
  lines.forEach((text, index) => {
    for (const { kind, pattern } of TOKEN_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ line: index + 1, kind });
        return;
      }
    }
    for (const candidate of text.match(ENTROPY_CANDIDATE) ?? []) {
      if (/^[0-9a-fA-F]+$/.test(candidate)) continue;
      if (shannonEntropy(candidate) >= ENTROPY_THRESHOLD) {
        findings.push({ line: index + 1, kind: "high-entropy string" });
        return;
      }
    }
  });
  return findings;
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}
