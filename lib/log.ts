/**
 * Minimal structured logger with PII redaction (RULE.md §5.10).
 *
 * Logs are JSON lines so Vercel log drains can index them. Any field whose
 * key looks sensitive is masked, and long digit runs (phone numbers) inside
 * string values are masked to their last 4 digits.
 */

type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY = /(pass|secret|token|key|auth|credential|otp|body|message|email|phone|number)/i;

function maskString(v: string): string {
  // 98XXXXXX21 style: keep last 4 digits of any 8+ digit run.
  return v.replace(/\d{4,}(\d{4})/g, (_m, last4: string) => `****${last4}`);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth]";
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: maskString(value.message) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof v !== "object" ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...(redact(fields ?? {}) as object) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};
