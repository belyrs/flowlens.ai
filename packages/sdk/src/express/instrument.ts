import { STATUS_CODES } from "node:http";
import type { Application, NextFunction, Request, Response } from "express";
import { getRequestContext, nextSequence, runWithRequestContext } from "../context/request-context.js";
import { HttpBatchEmitter } from "../emitter/http-batch-emitter.js";
import { createId } from "../lib/ids.js";
import { buildRedactionSummary, sanitizeHeaders, sanitizePayload } from "../lib/redaction.js";
import { resolveRoutePath } from "../lib/route.js";
import type { RuntimeEvent, ServiceDescriptor } from "../types.js";

interface ExpressInstrumentationOptions {
  app: Application;
  emitter: HttpBatchEmitter;
  service: ServiceDescriptor;
  sampleRate: number;
  redactHeaders?: string[];
  capturePayloads: boolean;
}

function shouldSample(sampleRate: number): boolean {
  return Math.random() <= sampleRate;
}

function extractRequestPath(req: Request): string {
  return req.originalUrl || req.url;
}

function shouldTrackRequest(req: Request): boolean {
  const method = req.method.toUpperCase();

  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return false;
  }

  const path = extractRequestPath(req).split("?")[0] || "/";
  return path !== "/favicon.ico";
}

function buildRequestMetadata(
  req: Request,
  capturePayloads: boolean,
  redactHeaders?: string[],
): Record<string, unknown> {
  return {
    rawPath: extractRequestPath(req),
    headers: sanitizeHeaders(req.headers as Record<string, unknown>, redactHeaders),
    query: sanitizePayload(req.query, redactHeaders),
    bodyCaptured: capturePayloads,
    body: capturePayloads ? sanitizePayload(req.body, redactHeaders) : undefined,
    contentType:
      typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
  };
}

function buildEventBase(
  req: Request,
  capturePayloads: boolean,
  redactHeaders?: string[],
): Pick<RuntimeEvent, "request" | "observationType" | "confidence" | "redaction" | "metadata"> {
  return {
    request: {
      id: getRequestContext()?.requestId ?? createId("request"),
      method: req.method,
      path: extractRequestPath(req),
      routePath: resolveRoutePath(req),
    },
    observationType: "observed",
    confidence: 1,
    redaction: buildRedactionSummary(redactHeaders, capturePayloads),
    metadata: buildRequestMetadata(req, capturePayloads, redactHeaders),
  };
}

export function instrumentExpress(options: ExpressInstrumentationOptions): void {
  const { app, emitter, sampleRate, redactHeaders, capturePayloads } = options;

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!shouldTrackRequest(req)) {
      next();
      return;
    }

    const startedAt = Date.now();
    const requestId = req.header("x-request-id") || createId("req");
    const sampled = shouldSample(sampleRate);

    runWithRequestContext(
      {
        requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        startedAt,
        eventSequence: 0,
        sampled,
      },
      () => {
        if (sampled) {
          emitter.enqueue({
            id: createId("evt"),
            type: "request.started",
            observedAt: new Date(startedAt).toISOString(),
            sequenceNo: nextSequence(),
            ...buildEventBase(req, capturePayloads, redactHeaders),
          });
        }

        res.on("finish", () => {
          const context = getRequestContext();

          if (!context?.sampled) {
            return;
          }

          context.routePath = resolveRoutePath(req);
          const statusMessage = res.statusMessage || STATUS_CODES[res.statusCode] || undefined;

          emitter.enqueue({
            id: createId("evt"),
            type: "request.finished",
            observedAt: new Date().toISOString(),
            sequenceNo: nextSequence(),
            durationMs: Date.now() - context.startedAt,
            statusCode: res.statusCode,
            response: {
              statusCode: res.statusCode,
              statusMessage,
            },
            request: {
              id: context.requestId,
              method: req.method,
              path: extractRequestPath(req),
              routePath: context.routePath,
            },
            observationType: "observed",
            confidence: 1,
            redaction: buildRedactionSummary(redactHeaders, capturePayloads),
            metadata: {
              rawPath: extractRequestPath(req),
              routePath: context.routePath,
              params: sanitizePayload(req.params, redactHeaders),
              statusMessage,
            },
          });

          emitter.flushSoon();
        });

        next();
      },
    );
  });
}
