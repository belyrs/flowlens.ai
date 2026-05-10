import type {
  CacheStrategy,
  EndpointGraph,
  GraphEdge,
  GraphNode,
  RuntimeEvent,
} from "@flowlens/shared-types";
import { createId } from "../lib/ids.js";

interface ProjectionInput {
  endpointId: string;
  method: string;
  routePath: string;
  events: RuntimeEvent[];
}

interface ProjectionSummary {
  cacheStrategy: CacheStrategy;
  writesData: boolean;
  hasCacheReads: boolean;
  hasDbReads: boolean;
  hasExternalCalls: boolean;
}

export interface ProjectedRunGraph extends EndpointGraph {
  summary: ProjectionSummary;
}

function responseLabel(statusCode: number, statusMessage?: string): string {
  return statusMessage ? `Response ${statusCode} ${statusMessage}` : `Response ${statusCode}`;
}

function buildEndpointMetadata(
  method: string,
  routePath: string,
  events: RuntimeEvent[],
): Record<string, unknown> {
  const startedEvent = events.find((event) => event.type === "request.started");
  const finishedEvent = [...events].reverse().find((event) => event.type === "request.finished");

  return {
    method,
    routePath,
    requestId: startedEvent?.request.id ?? finishedEvent?.request.id,
    rawPath:
      (finishedEvent?.metadata?.rawPath as string | undefined) ??
      (startedEvent?.metadata?.rawPath as string | undefined) ??
      finishedEvent?.request.path ??
      startedEvent?.request.path,
    headers: startedEvent?.metadata?.headers,
    query: startedEvent?.metadata?.query,
    params: finishedEvent?.metadata?.params,
    bodyCaptured:
      (startedEvent?.metadata?.bodyCaptured as boolean | undefined) ?? false,
    body: startedEvent?.metadata?.body,
    contentType: startedEvent?.metadata?.contentType,
    startedAt: startedEvent?.observedAt,
  };
}

function createEndpointNode(
  method: string,
  routePath: string,
  events: RuntimeEvent[],
): GraphNode {
  return {
    id: createId("node"),
    key: `endpoint:${method}:${routePath}`,
    nodeType: "api-endpoint",
    label: `${method} ${routePath}`,
    operationKind: "request",
    observationType: "observed",
    confidence: 1,
    isWrite: false,
    metadata: buildEndpointMetadata(method, routePath, events),
    sequenceIndex: 0,
  };
}

function createResponseNode(
  statusCode: number,
  statusMessage: string | undefined,
  durationMs: number | undefined,
  observedAt: string | undefined,
  sequenceIndex: number,
): GraphNode {
  return {
    id: createId("node"),
    key: `response:${statusCode}:${statusMessage ?? "unknown"}`,
    nodeType: "response",
    label: responseLabel(statusCode, statusMessage),
    operationKind: "response",
    observationType: "observed",
    confidence: 1,
    isWrite: false,
    metadata: {
      statusCode,
      statusMessage,
      durationMs,
      observedAt,
    },
    sequenceIndex,
  };
}

function projectOperationNode(event: RuntimeEvent, sequenceIndex: number): GraphNode | null {
  if (event.type === "redis.command" && event.redis) {
    const namespace = event.redis.keyNamespace ? ` ${event.redis.keyNamespace}` : "";
    return {
      id: createId("node"),
      key: `redis:${event.redis.command}:${event.redis.keyNamespace ?? "unknown"}`,
      nodeType: "redis",
      label: `Redis ${event.redis.command}${namespace}`,
      operationKind: event.redis.write ? "write" : "read",
      observationType: event.observationType,
      confidence: event.confidence,
      isWrite: event.redis.write,
      metadata: {
        command: event.redis.command,
        keyNamespace: event.redis.keyNamespace,
        keyHash: event.redis.keyHash,
      },
      sequenceIndex,
    };
  }

  if (event.type === "db.query" && event.db) {
    const tableText = event.db.tables?.length ? ` ${event.db.tables.join(", ")}` : "";
    return {
      id: createId("node"),
      key: `postgresql:${event.db.operation}:${event.db.tables?.join(",") ?? "unknown"}`,
      nodeType: "postgresql",
      label: `PostgreSQL ${event.db.operation}${tableText}`,
      operationKind: event.db.write ? "write" : "read",
      observationType: event.observationType,
      confidence: event.confidence,
      isWrite: event.db.write,
      metadata: {
        operation: event.db.operation,
        tables: event.db.tables ?? [],
        normalizedSql: event.db.normalizedSql,
      },
      sequenceIndex,
    };
  }

  if (event.type === "external.http" && event.http) {
    const label =
      event.http.label ??
      (event.http.transport === "blockchain"
        ? `CORD ${event.http.operation ?? "blockchain call"}`
        : `${event.http.method} ${event.http.host}`);
    const isWrite =
      event.http.transport === "blockchain" ||
      !["GET", "HEAD"].includes(event.http.method.toUpperCase());

    return {
      id: createId("node"),
      key:
        `external:${event.http.transport ?? "http"}:` +
        `${event.http.method}:${event.http.host}:${event.http.operation ?? event.http.pathTemplate ?? "/"}`,
      nodeType: "external-service",
      label,
      operationKind: isWrite ? "write" : "call",
      observationType: event.observationType,
      confidence: event.confidence,
      isWrite,
      metadata: {
        method: event.http.method,
        host: event.http.host,
        pathTemplate: event.http.pathTemplate,
        statusCode: event.http.statusCode,
        transport: event.http.transport ?? "http",
        serviceName: event.http.serviceName,
        operation: event.http.operation,
        label,
        ...event.metadata,
      },
      sequenceIndex,
    };
  }

  return null;
}

function inferCacheStrategy(nodes: GraphNode[]): CacheStrategy {
  const hasCacheReads = nodes.some(
    (node) => node.nodeType === "redis" && node.operationKind === "read",
  );
  const hasDbReads = nodes.some(
    (node) => node.nodeType === "postgresql" && node.operationKind === "read",
  );

  if (hasCacheReads && hasDbReads) {
    return "cache-then-db";
  }

  if (hasCacheReads) {
    return "cache-only";
  }

  if (hasDbReads) {
    return "db-only";
  }

  return "unknown";
}

export function projectRunGraph(input: ProjectionInput): ProjectedRunGraph {
  const nodes: GraphNode[] = [createEndpointNode(input.method, input.routePath, input.events)];
  const edges: GraphEdge[] = [];

  const operationEvents = input.events.filter(
    (event) => event.type !== "request.started" && event.type !== "request.finished",
  );

  let sequenceIndex = 1;

  for (const event of operationEvents) {
    const node = projectOperationNode(event, sequenceIndex);

    if (node) {
      nodes.push(node);
      sequenceIndex += 1;
    }
  }

  const finishedEvent =
    [...input.events]
      .reverse()
      .find((event) => event.type === "request.finished") ?? null;

  const responseNode = createResponseNode(
    finishedEvent?.statusCode ?? 200,
    finishedEvent?.response?.statusMessage ??
      (finishedEvent?.metadata?.statusMessage as string | undefined),
    finishedEvent?.durationMs,
    finishedEvent?.observedAt,
    sequenceIndex,
  );
  nodes.push(responseNode);

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const current = nodes[index];
    const next = nodes[index + 1];

    let edgeType: GraphEdge["edgeType"] = "request-flow";

    if (
      current.nodeType === "redis" &&
      current.operationKind === "read" &&
      next.nodeType === "postgresql" &&
      next.operationKind === "read"
    ) {
      edgeType = "cache-fallback";
    }

    if (next.nodeType === "response") {
      edgeType = "response";
    }

    edges.push({
      id: createId("edge"),
      from: current.key,
      to: next.key,
      edgeType,
      observationType:
        current.observationType === "observed" && next.observationType === "observed"
          ? "observed"
          : "inferred",
      confidence: Math.min(current.confidence, next.confidence),
      occurrenceCount: 1,
      metadata: {},
    });
  }

  const summary: ProjectionSummary = {
    cacheStrategy: inferCacheStrategy(nodes),
    writesData: nodes.some((node) => node.isWrite),
    hasCacheReads: nodes.some(
      (node) => node.nodeType === "redis" && node.operationKind === "read",
    ),
    hasDbReads: nodes.some(
      (node) => node.nodeType === "postgresql" && node.operationKind === "read",
    ),
    hasExternalCalls: nodes.some((node) => node.nodeType === "external-service"),
  };

  return {
    endpointId: input.endpointId,
    snapshotKind: "latest",
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    summary,
  };
}

export function projectAggregateGraph(
  endpointId: string,
  runGraphs: ProjectedRunGraph[],
): EndpointGraph {
  const nodeMap = new Map<
    string,
    {
      node: GraphNode;
      occurrenceCount: number;
      totalConfidence: number;
      minSequence: number;
    }
  >();

  const edgeMap = new Map<
    string,
    {
      edge: GraphEdge;
      occurrenceCount: number;
      totalConfidence: number;
    }
  >();

  for (const graph of runGraphs) {
    for (const node of graph.nodes) {
      const existing = nodeMap.get(node.key);

      if (existing) {
        existing.occurrenceCount += 1;
        existing.totalConfidence += node.confidence;
        existing.minSequence = Math.min(existing.minSequence, node.sequenceIndex);
      } else {
        nodeMap.set(node.key, {
          node: {
            ...node,
            id: createId("agg_node"),
          },
          occurrenceCount: 1,
          totalConfidence: node.confidence,
          minSequence: node.sequenceIndex,
        });
      }
    }

    for (const edge of graph.edges) {
      const mapKey = `${edge.from}->${edge.to}:${edge.edgeType}`;
      const existing = edgeMap.get(mapKey);

      if (existing) {
        existing.occurrenceCount += 1;
        existing.totalConfidence += edge.confidence;
      } else {
        edgeMap.set(mapKey, {
          edge: {
            ...edge,
            id: createId("agg_edge"),
          },
          occurrenceCount: 1,
          totalConfidence: edge.confidence,
        });
      }
    }
  }

  const nodes = [...nodeMap.values()]
    .map(({ node, occurrenceCount, totalConfidence, minSequence }) => ({
      ...node,
      confidence: totalConfidence / occurrenceCount,
      sequenceIndex: minSequence,
      metadata: {
        ...node.metadata,
        occurrenceCount,
      },
    }))
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);

  const edges = [...edgeMap.values()].map(({ edge, occurrenceCount, totalConfidence }) => ({
    ...edge,
    confidence: totalConfidence / occurrenceCount,
    occurrenceCount,
    metadata: {
      ...edge.metadata,
      occurrenceCount,
    },
  }));

  const summary = runGraphs.reduce<ProjectionSummary>(
    (accumulator, graph) => ({
      cacheStrategy:
        accumulator.cacheStrategy === graph.summary.cacheStrategy
          ? accumulator.cacheStrategy
          : accumulator.cacheStrategy === "unknown"
            ? graph.summary.cacheStrategy
            : graph.summary.cacheStrategy === "unknown"
              ? accumulator.cacheStrategy
              : accumulator.cacheStrategy === graph.summary.cacheStrategy
                ? accumulator.cacheStrategy
                : "mixed",
      writesData: accumulator.writesData || graph.summary.writesData,
      hasCacheReads: accumulator.hasCacheReads || graph.summary.hasCacheReads,
      hasDbReads: accumulator.hasDbReads || graph.summary.hasDbReads,
      hasExternalCalls: accumulator.hasExternalCalls || graph.summary.hasExternalCalls,
    }),
    {
      cacheStrategy: "unknown",
      writesData: false,
      hasCacheReads: false,
      hasDbReads: false,
      hasExternalCalls: false,
    },
  );

  return {
    endpointId,
    snapshotKind: "aggregate",
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    summary,
  };
}
