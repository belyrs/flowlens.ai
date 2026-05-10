import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { getRequestContext, nextSequence } from "../context/request-context.js";
import { HttpBatchEmitter } from "../emitter/http-batch-emitter.js";
import { createId } from "../lib/ids.js";
import { buildRedactionSummary } from "../lib/redaction.js";
import type { RequestReference } from "../types.js";

interface HttpInstrumentationOptions {
  emitter: HttpBatchEmitter;
  redactHeaders?: string[];
}

const PATCHED_FETCH = Symbol.for("flowlens.fetch.patched");
const PATCHED_HTTP = Symbol.for("flowlens.http.patched");

function snapshotRequest(): RequestReference | null {
  const context = getRequestContext();

  if (!context?.sampled) {
    return null;
  }

  return {
    id: context.requestId,
    method: context.method,
    path: context.path,
    routePath: context.routePath,
  };
}

function emitExternalEvent(
  options: HttpInstrumentationOptions,
  request: RequestReference,
  input: {
    durationMs: number;
    method: string;
    host: string;
    pathTemplate?: string;
    statusCode?: number;
    transport?: "http" | "blockchain";
    serviceName?: string;
    operation?: string;
    label?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  options.emitter.enqueue({
    id: createId("evt"),
    type: "external.http",
    observedAt: new Date().toISOString(),
    sequenceNo: nextSequence(),
    durationMs: input.durationMs,
    request,
    observationType: "observed",
    confidence: 1,
    http: {
      method: input.method,
      host: input.host,
      pathTemplate: input.pathTemplate,
      statusCode: input.statusCode,
      transport: input.transport,
      serviceName: input.serviceName,
      operation: input.operation,
      label: input.label,
    },
    redaction: buildRedactionSummary(options.redactHeaders),
    metadata: input.metadata,
  });
}

function parseRequestTarget(
  protocol: "http" | "https",
  args: unknown[],
): {
  method: string;
  host: string;
  pathTemplate: string;
  href: string;
} {
  const first = args[0];
  const second = args[1];
  const requestOptions =
    (typeof second === "object" && second !== null ? second : undefined) as RequestOptions | undefined;

  if (first instanceof URL || typeof first === "string") {
    const fallbackHost =
      requestOptions?.hostname ?? requestOptions?.host ?? "localhost";
    const fallbackPort = requestOptions?.port ? `:${String(requestOptions.port)}` : "";
    const fallbackBase = `${protocol}://${String(fallbackHost)}${fallbackPort}`;
    const targetUrl = new URL(String(first), fallbackBase);
    const method = (requestOptions?.method ?? "GET").toUpperCase();

    return {
      method,
      host: targetUrl.host,
      pathTemplate: targetUrl.pathname,
      href: targetUrl.toString(),
    };
  }

  const options = (typeof first === "object" && first !== null ? first : {}) as RequestOptions;
  const method = (options.method ?? requestOptions?.method ?? "GET").toUpperCase();
  const hostname = options.hostname ?? options.host ?? requestOptions?.hostname ?? requestOptions?.host ?? "localhost";
  const port = options.port ?? requestOptions?.port;
  const path = typeof options.path === "string" ? options.path : typeof requestOptions?.path === "string" ? requestOptions.path : "/";
  const host = `${String(hostname)}${port ? `:${String(port)}` : ""}`;
  const pathTemplate = path.split("?")[0] || "/";

  return {
    method,
    host,
    pathTemplate,
    href: `${protocol}://${host}${path}`,
  };
}

function patchNodeHttpModule(
  module: typeof http | typeof https,
  protocol: "http" | "https",
  options: HttpInstrumentationOptions,
): void {
  const target = module as typeof module & { [PATCHED_HTTP]?: boolean };

  if (target[PATCHED_HTTP]) {
    return;
  }

  const originalRequest = module.request.bind(module) as (...args: unknown[]) => ClientRequest;

  module.request = ((...args: unknown[]) => {
    const request = snapshotRequest();

    if (!request) {
      return originalRequest(...args);
    }

    const startedAt = Date.now();
    const targetInfo = parseRequestTarget(protocol, args as unknown[]);
    const clientRequest = originalRequest(...args);
    let emitted = false;

    const flush = (
      statusCode?: number,
      metadata?: Record<string, unknown>,
    ) => {
      if (emitted) {
        return;
      }

      emitted = true;
      emitExternalEvent(options, request, {
        durationMs: Date.now() - startedAt,
        method: targetInfo.method,
        host: targetInfo.host,
        pathTemplate: targetInfo.pathTemplate,
        statusCode,
        transport: "http",
        label: `${targetInfo.method} ${targetInfo.host}`,
        metadata: {
          url: targetInfo.href,
          ...metadata,
        },
      });
    };

    clientRequest.on("response", (response: IncomingMessage) => {
      flush(response.statusCode, {
        statusMessage: response.statusMessage,
      });
    });

    clientRequest.on("error", (error: Error) => {
      flush(undefined, {
        error: error.message,
      });
    });

    return clientRequest;
  }) as typeof module.request;

  target[PATCHED_HTTP] = true;
}

export function instrumentFetch(options: HttpInstrumentationOptions): void {
  const globalObject = globalThis as typeof globalThis & {
    [PATCHED_FETCH]?: boolean;
  };

  if (typeof globalThis.fetch === "function" && !globalObject[PATCHED_FETCH]) {
    const originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = snapshotRequest();

      if (!request) {
        return originalFetch(input, init);
      }

      const startedAt = Date.now();
      const targetHref =
        typeof input === "string" ? input
        : input instanceof URL ? input.toString()
        : input.url;
      const requestMethod =
        (init?.method ??
          (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();

      try {
        const response = await originalFetch(input, init);
        const target = new URL(targetHref);

        emitExternalEvent(options, request, {
          durationMs: Date.now() - startedAt,
          method: requestMethod,
          host: target.host,
          pathTemplate: target.pathname,
          statusCode: response.status,
          transport: "http",
          label: `${requestMethod} ${target.host}`,
          metadata: {
            url: target.toString(),
            statusText: response.statusText,
          },
        });

        return response;
      } catch (error) {
        const fallbackTarget = new URL(targetHref);

        emitExternalEvent(options, request, {
          durationMs: Date.now() - startedAt,
          method: requestMethod,
          host: fallbackTarget.host,
          pathTemplate: fallbackTarget.pathname,
          transport: "http",
          label: `${requestMethod} ${fallbackTarget.host}`,
          metadata: {
            url: fallbackTarget.toString(),
            error: error instanceof Error ? error.message : "Unknown fetch error",
          },
        });

        throw error;
      }
    }) as typeof globalThis.fetch;

    globalObject[PATCHED_FETCH] = true;
  }

  patchNodeHttpModule(http, "http", options);
  patchNodeHttpModule(https, "https", options);
}
