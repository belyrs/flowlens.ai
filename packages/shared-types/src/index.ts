export type ObservationType = "observed" | "inferred" | "unknown";

export type RuntimeEventType =
  | "request.started"
  | "request.finished"
  | "db.query"
  | "redis.command"
  | "external.http";

export type NodeType =
  | "api-endpoint"
  | "redis"
  | "postgresql"
  | "response"
  | "external-service";

export type OperationKind = "request" | "read" | "write" | "call" | "response";

export type EdgeType = "request-flow" | "cache-fallback" | "response";

export type SnapshotKind = "latest" | "aggregate";

export type CacheStrategy =
  | "cache-only"
  | "db-only"
  | "cache-then-db"
  | "mixed"
  | "unknown";

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

export interface ServiceSummary {
  id: string;
  name: string;
  runtime: string;
  framework: string;
  sdkVersion: string | null;
  endpointCount: number;
  lastSeenAt: string | null;
}

export interface EndpointSummary {
  id: string;
  serviceId: string;
  method: string;
  routePath: string;
  normalizedPath: string;
  hasCacheReads: boolean;
  hasDbReads: boolean;
  hasWrites: boolean;
  hasExternalCalls: boolean;
  cacheStrategy: CacheStrategy;
  latestStatusCode: number | null;
  lastSeenAt: string | null;
}

export interface GraphNode {
  id: string;
  key: string;
  nodeType: NodeType;
  label: string;
  operationKind: OperationKind;
  observationType: ObservationType;
  confidence: number;
  isWrite: boolean;
  metadata: Record<string, unknown>;
  sequenceIndex: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  edgeType: EdgeType;
  observationType: ObservationType;
  confidence: number;
  occurrenceCount: number;
  metadata: Record<string, unknown>;
}

export interface EndpointGraph {
  endpointId: string;
  snapshotKind: SnapshotKind;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: {
    cacheStrategy: CacheStrategy;
    writesData: boolean;
    hasCacheReads: boolean;
    hasDbReads: boolean;
    hasExternalCalls: boolean;
  };
}

export interface FlowRunSummary {
  id: string;
  serviceId: string;
  endpointId: string;
  requestId: string;
  method: string;
  routePath: string;
  statusCode: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  observationState: "observed" | "incomplete";
}

export interface FlowRunDetail extends FlowRunSummary {
  rawPath?: string;
  redaction: RedactionSummary | null;
  timeline: RuntimeEvent[];
  graph: EndpointGraph;
}

export interface EndpointDetail {
  endpoint: EndpointSummary;
  latestRun: FlowRunSummary | null;
  latestGraph: EndpointGraph | null;
  aggregateGraph: EndpointGraph | null;
  recentRuns: FlowRunSummary[];
}
