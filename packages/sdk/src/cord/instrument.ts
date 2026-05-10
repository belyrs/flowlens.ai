import { getRequestContext, nextSequence } from "../context/request-context.js";
import { HttpBatchEmitter } from "../emitter/http-batch-emitter.js";
import { createId } from "../lib/ids.js";
import { buildRedactionSummary } from "../lib/redaction.js";

interface CordInstrumentationOptions {
  emitter: HttpBatchEmitter;
  redactHeaders?: string[];
}

const PATCHED_CORD = Symbol.for("flowlens.cord.patched");
const CORD_HOST = "cord.network";
const WRAPPED_NAMESPACES = ["Registry", "Entry", "Profile", "Chain"] as const;

type AnyFunction = (...args: unknown[]) => unknown;

function safeRequire(moduleName: string): unknown {
  try {
    const requireFn = eval("require") as NodeJS.Require;
    return requireFn(moduleName);
  } catch {
    return null;
  }
}

function shouldWrapFunction(namespace: string, methodName: string): boolean {
  if (namespace === "Chain" && methodName === "signAndSubmitTx") {
    return true;
  }

  return methodName.startsWith("dispatch");
}

function emitCordEvent(
  options: CordInstrumentationOptions,
  namespace: string,
  methodName: string,
  durationMs: number,
  outcome: "success" | "error",
  errorMessage?: string,
): void {
  const context = getRequestContext();

  if (!context?.sampled) {
    return;
  }

  options.emitter.enqueue({
    id: createId("evt"),
    type: "external.http",
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
    http: {
      method: "POST",
      host: CORD_HOST,
      pathTemplate: `/${namespace}.${methodName}`,
      statusCode: outcome === "success" ? 200 : 500,
      transport: "blockchain",
      serviceName: "cord",
      operation: `${namespace}.${methodName}`,
      label: `CORD ${namespace}.${methodName}`,
    },
    redaction: buildRedactionSummary(options.redactHeaders),
    metadata: {
      transport: "blockchain",
      provider: "cord",
      namespace,
      methodName,
      outcome,
      error: errorMessage,
    },
  });
}

function wrapCordMethod(
  options: CordInstrumentationOptions,
  namespace: string,
  methodName: string,
  fn: AnyFunction,
): AnyFunction {
  return async function wrappedCordMethod(this: unknown, ...args: unknown[]) {
    const startedAt = Date.now();

    try {
      const result = await fn.apply(this, args);
      emitCordEvent(options, namespace, methodName, Date.now() - startedAt, "success");
      return result;
    } catch (error) {
      emitCordEvent(
        options,
        namespace,
        methodName,
        Date.now() - startedAt,
        "error",
        error instanceof Error ? error.message : "Unknown CORD error",
      );
      throw error;
    }
  };
}

export function instrumentCord(options: CordInstrumentationOptions): void {
  const loaded = safeRequire("@cord.network/sdk") as Record<string, unknown> | null;
  const cordModule = (loaded &&
    typeof loaded === "object" &&
    "default" in loaded &&
    loaded.default &&
    typeof loaded.default === "object"
      ? (loaded.default as Record<string, unknown>)
      : loaded) as Record<string, unknown> | null;

  if (!cordModule) {
    return;
  }

  const patchTarget = cordModule as Record<string | symbol, unknown>;

  if (patchTarget[PATCHED_CORD]) {
    return;
  }

  for (const namespace of WRAPPED_NAMESPACES) {
    const namespaceValue = cordModule[namespace];

    if (!namespaceValue || typeof namespaceValue !== "object") {
      continue;
    }

    const mutableNamespace = namespaceValue as Record<string, unknown>;

    for (const [methodName, value] of Object.entries(mutableNamespace)) {
      if (typeof value !== "function" || !shouldWrapFunction(namespace, methodName)) {
        continue;
      }

      const wrapped = wrapCordMethod(
        options,
        namespace,
        methodName,
        value as AnyFunction,
      );
      const descriptor = Object.getOwnPropertyDescriptor(mutableNamespace, methodName);

      if (!descriptor) {
        mutableNamespace[methodName] = wrapped;
        continue;
      }

      if ("writable" in descriptor && descriptor.writable) {
        mutableNamespace[methodName] = wrapped;
        continue;
      }

      if (descriptor.configurable) {
        Object.defineProperty(mutableNamespace, methodName, {
          configurable: true,
          enumerable: descriptor.enumerable ?? true,
          value: wrapped,
          writable: true,
        });
      }
    }
  }

  patchTarget[PATCHED_CORD] = true;
}
