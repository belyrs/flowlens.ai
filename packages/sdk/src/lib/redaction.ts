import type { RedactionSummary } from "../types.js";

const DEFAULT_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
];

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|secret|password|token|api[-_]?key|client[-_]?secret|mnemonic|private[-_]?key|passphrase)/i;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 30;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING_LENGTH = 2_000;

export function buildRedactionSummary(
  headers?: string[],
  payloadCaptured = false,
): RedactionSummary {
  return {
    headersRedacted: headers ?? DEFAULT_HEADERS,
    payloadCaptured,
    sqlParamsCaptured: false,
    redisKeysHashed: true,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRedactedHeaders(headers?: string[]): Set<string> {
  return new Set((headers ?? DEFAULT_HEADERS).map((header) => header.toLowerCase()));
}

function sanitizeString(value: string): string {
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function sanitizeValue(
  value: unknown,
  redactedHeaders: Set<string>,
  depth: number,
  keyHint?: string,
): unknown {
  if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
    return REDACTED_VALUE;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.byteLength} bytes]`;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return `[Array(${value.length})]`;
    }

    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, redactedHeaders, depth + 1, keyHint));
  }

  if (isPlainObject(value)) {
    if (depth >= MAX_DEPTH) {
      return "[Object]";
    }

    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);

    return Object.fromEntries(
      entries.map(([key, innerValue]) => [
        key,
        sanitizeValue(innerValue, redactedHeaders, depth + 1, key),
      ]),
    );
  }

  try {
    return sanitizeString(String(value));
  } catch {
    return "[Unserializable]";
  }
}

export function sanitizeHeaders(
  headers: Record<string, unknown>,
  redactedHeaders?: string[],
): Record<string, unknown> {
  const redacted = normalizeRedactedHeaders(redactedHeaders);

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      if (redacted.has(key.toLowerCase()) || SENSITIVE_KEY_PATTERN.test(key)) {
        return [key, REDACTED_VALUE];
      }

      return [key, sanitizeValue(value, redacted, 0, key)];
    }),
  );
}

export function sanitizePayload(
  value: unknown,
  redactedHeaders?: string[],
): unknown {
  return sanitizeValue(value, normalizeRedactedHeaders(redactedHeaders), 0);
}

export function hashValue(value: string): string {
  const digest = Buffer.from(value).toString("base64url");
  return `opaque:${digest.slice(0, 24)}`;
}

export function extractRedisNamespace(key?: unknown): string | undefined {
  if (typeof key !== "string" || key.length === 0) {
    return undefined;
  }

  return key.split(":")[0];
}
