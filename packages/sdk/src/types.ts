export type ObservationType = "observed" | "inferred" | "unknown";

export type RuntimeEventType =
  | "request.started"
  | "request.finished"
  | "db.query"
  | "redis.command"
  | "external.http";

export interface RequestReference {
  id: string;
  method: string;
  path?: string;
  routePath?: string;
}

export interface RedactionSummary {
  headersRedacted: string[];
  payloadCaptured: boolean;
  sqlParamsCaptured?: boolean;
  redisKeysHashed?: boolean;
}

export interface ServiceDescriptor {
  name: string;
  runtime: "node";
  framework: "express";
  version?: string;
  environment?: string;
}

export interface SdkDescriptor {
  name: "backend-flow-mapper-sdk";
  version: string;
}

export interface DbEventPayload {
  driver: "postgresql";
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "UNKNOWN";
  tables?: string[];
  normalizedSql?: string;
  rowCount?: number;
  write: boolean;
}

export interface RedisEventPayload {
  command: string;
  operation: "read" | "write" | "unknown";
  keyNamespace?: string;
  keyHash?: string;
  write: boolean;
}

export interface ExternalHttpEventPayload {
  method: string;
  host: string;
  pathTemplate?: string;
  statusCode?: number;
  transport?: "http" | "blockchain";
  serviceName?: string;
  operation?: string;
  label?: string;
}

export interface ResponseEventPayload {
  statusCode: number;
  statusMessage?: string;
}

export interface RuntimeEvent {
  id: string;
  parentEventId?: string;
  type: RuntimeEventType;
  observedAt: string;
  sequenceNo?: number;
  request: RequestReference;
  observationType: ObservationType;
  confidence: number;
  durationMs?: number;
  statusCode?: number;
  db?: DbEventPayload;
  redis?: RedisEventPayload;
  http?: ExternalHttpEventPayload;
  response?: ResponseEventPayload;
  redaction?: RedactionSummary;
  metadata?: Record<string, unknown>;
}

export interface RuntimeEventBatch {
  schemaVersion: "1.0";
  sentAt: string;
  service: ServiceDescriptor;
  sdk: SdkDescriptor;
  events: RuntimeEvent[];
}
