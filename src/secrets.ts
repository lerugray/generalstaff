export type SecretKind =
  | "pem_private_key"
  | "aws_access_key"
  | "github_token"
  | "openai_token"
  | "anthropic_token"
  | "google_api_key"
  | "slack_token"
  | "stripe_secret"
  | "bearer_token"
  | "secret_assignment"
  | "exported_high_entropy_value";

export interface SecretRedaction {
  redacted: string;
  hits: Array<{ kind: SecretKind; count: number }>;
}

function maskFor(kind: SecretKind): string {
  return `[REDACTED:${kind}]`;
}

function highEntropyValue(raw: string): boolean {
  const value = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (value.length < 20) return false;
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;
  return classes >= 2 && new Set(value).size >= 10;
}

function addHit(counts: Map<SecretKind, number>, kind: SecretKind): void {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

function replaceWhole(
  input: string,
  regex: RegExp,
  kind: SecretKind,
  counts: Map<SecretKind, number>,
): string {
  return input.replace(regex, () => {
    addHit(counts, kind);
    return maskFor(kind);
  });
}

/**
 * Pure, deliberately small scanner for content that crosses the cycle-artifact
 * or reviewer boundary. It is not a credential validator: prefix-shaped
 * values are masked unconditionally, while generic assignments require a
 * high-entropy value to limit false positives.
 */
export function redactSecrets(input: string): SecretRedaction {
  const counts = new Map<SecretKind, number>();
  let redacted = input;

  redacted = replaceWhole(
    redacted,
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    "pem_private_key",
    counts,
  );
  redacted = replaceWhole(
    redacted,
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    "anthropic_token",
    counts,
  );
  redacted = replaceWhole(
    redacted,
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
    "openai_token",
    counts,
  );
  redacted = replaceWhole(
    redacted,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    "aws_access_key",
    counts,
  );
  redacted = replaceWhole(
    redacted,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    "github_token",
    counts,
  );
  redacted = replaceWhole(
    redacted,
    /\bAIza[A-Za-z0-9_-]{35}\b/g,
    "google_api_key",
    counts,
  );
  redacted = replaceWhole(
    redacted,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    "slack_token",
    counts,
  );
  redacted = replaceWhole(
    redacted,
    /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
    "stripe_secret",
    counts,
  );
  redacted = redacted.replace(
    /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}={0,2})/gi,
    (_match, prefix: string) => {
      addHit(counts, "bearer_token");
      return `${prefix}${maskFor("bearer_token")}`;
    },
  );

  redacted = redacted
    .split(/(\r?\n)/)
    .map((line) => {
      if (line === "\n" || line === "\r\n") return line;
      const match = line.match(
        /^([+\- ]?(?:(export)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(["']?)([^"'\s#]+)\4(.*)$/,
      );
      if (!match || !highEntropyValue(match[5])) return line;
      const name = match[3].toLowerCase();
      const secretNamed =
        /(?:api[_-]?key|token|secret|password|passwd|credential|private[_-]?key)/.test(name);
      if (!secretNamed && !match[2]) return line;
      const kind: SecretKind = secretNamed
        ? "secret_assignment"
        : "exported_high_entropy_value";
      addHit(counts, kind);
      return `${match[1]}${match[4]}${maskFor(kind)}${match[4]}${match[6]}`;
    })
    .join("");

  return {
    redacted,
    hits: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
  };
}

export function formatSecretRedactionWarning(
  artifact: string,
  hits: SecretRedaction["hits"],
): string {
  const total = hits.reduce((sum, hit) => sum + hit.count, 0);
  const kinds = hits.map((hit) => `${hit.kind}:${hit.count}`).join(", ");
  return `[generalstaff] warning: redacted ${total} potential secret(s) from ${artifact} (${kinds})`;
}

/**
 * Same scanner as `redactSecrets`, but never throws. If the scanner fails,
 * the raw input is returned untouched and a warning string is returned so
 * the caller can surface it without failing the cycle.
 */
export function redactSecretsSafe(
  input: string,
): SecretRedaction & { warning?: string } {
  try {
    return redactSecrets(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      redacted: input,
      hits: [],
      warning:
        `[generalstaff] WARNING: secret redaction failed (${message}); ` +
        `output is being persisted unredacted`,
    };
  }
}
