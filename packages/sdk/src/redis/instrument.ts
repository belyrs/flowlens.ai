import { getRequestContext, nextSequence } from "../context/request-context.js";
import { HttpBatchEmitter } from "../emitter/http-batch-emitter.js";
import { createId } from "../lib/ids.js";
import { classifyRedisCommand } from "../lib/redis.js";
import { buildRedactionSummary, extractRedisNamespace, hashValue } from "../lib/redaction.js";
import type { RuntimeEvent } from "../types.js";

interface RedisInstrumentationOptions {
  redisClient: object;
  emitter: HttpBatchEmitter;
  redactHeaders?: string[];
}

const METHODS_TO_PATCH = [
  "get",
  "mGet",
  "hGet",
  "exists",
  "set",
  "del",
  "hSet",
  "incr",
  "expire",
] as const;

function buildRedisEvent(
  methodName: string,
  key: unknown,
  durationMs: number,
  redactHeaders?: string[],
): RuntimeEvent | null {
  const context = getRequestContext();

  if (!context?.sampled) {
    return null;
  }

  const command = classifyRedisCommand(methodName);
  const keyString = typeof key === "string" ? key : undefined;

  return {
    id: createId("evt"),
    type: "redis.command",
    observedAt: new Date().toISOString(),
    sequenceNo: nextSequence(),
    durationMs,
    request: {
      id: context.requestId,
      method: context.method,
      path: context.path,
      routePath: context.routePath,
    },
    observationType: "observed",
    confidence: 1,
    redis: {
      command: command.command,
      operation: command.operation,
      keyNamespace: extractRedisNamespace(keyString),
      keyHash: keyString ? hashValue(keyString) : undefined,
      write: command.write,
    },
    redaction: buildRedactionSummary(redactHeaders),
  };
}

export function instrumentRedis(options: RedisInstrumentationOptions): void {
  const { emitter, redactHeaders } = options;
  const redisClient = options.redisClient as Record<string, unknown>;

  for (const methodName of METHODS_TO_PATCH) {
    const original = redisClient[methodName];

    if (typeof original !== "function") {
      continue;
    }

    redisClient[methodName] = (async (...args: unknown[]) => {
      const startedAt = Date.now();
      const result = await (original as (...innerArgs: unknown[]) => Promise<unknown>).apply(
        redisClient,
        args,
      );
      const event = buildRedisEvent(methodName, args[0], Date.now() - startedAt, redactHeaders);

      if (event) {
        emitter.enqueue(event);
      }

      return result;
    }) as unknown;
  }
}
