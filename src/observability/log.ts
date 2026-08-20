import { LOG_LEVELS, type LogLevel } from "../config.js";

/**
 * Field names whose values are secrets or high-entropy artefacts. Anything matching is
 * replaced or truncated before serialisation, so a support log can be shared without
 * leaking the Turnkey credentials, either API key, or a reusable signature.
 */
const REDACTED_KEYS = new Set([
  "apikey",
  "apiprivatekey",
  "apipublickey",
  "authorization",
  "builderapikey",
  "dpmwalletapikey",
  "mnemonic",
  "privatekey",
  "secret",
  "turnkeyapiprivatekey",
  "turnkeyapipublickey",
  "x-api-key",
  "x-builder-api-private-key",
]);

/** Fields kept as a short prefix: identifying enough for support, useless to replay. */
const TRUNCATED_KEYS = new Set(["signature", "signedtransaction", "signaturehex"]);

const TRUNCATED_PREFIX_LENGTH = 12;

let activeLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

export function logDebug(event: string, fields?: Record<string, unknown>): void {
  emit("debug", event, fields);
}

export function logInfo(event: string, fields?: Record<string, unknown>): void {
  emit("info", event, fields);
}

export function logWarn(event: string, fields?: Record<string, unknown>): void {
  emit("warn", event, fields);
}

export function logError(event: string, fields?: Record<string, unknown>): void {
  emit("error", event, fields);
}

/** Applies the same redaction rules outside logging, e.g. before persisting audit detail. */
export function redact(value: unknown): unknown {
  return redactValue(value);
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(activeLevel)) return;
  const line = serialize({ level, event, ...redactFields(fields) });
  if (level === "error" || level === "warn") {
    console.error(line);
    return;
  }
  console.log(line);
}

/** One JSON line per entry, matching the prediction-gateway logging convention. */
function serialize(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  return redactValue(fields) as Record<string, unknown>;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value instanceof Set) return [...value].map(redactValue);
  if (value instanceof Error || value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactEntry(key, entry);
  }
  return output;
}

function redactEntry(key: string, entry: unknown): unknown {
  const normalized = key.toLowerCase();
  if (REDACTED_KEYS.has(normalized)) return "[redacted]";
  if (TRUNCATED_KEYS.has(normalized) && typeof entry === "string") return truncate(entry);
  return redactValue(entry);
}

function truncate(value: string): string {
  if (value.length <= TRUNCATED_PREFIX_LENGTH) return value;
  return `${value.slice(0, TRUNCATED_PREFIX_LENGTH)}…`;
}
