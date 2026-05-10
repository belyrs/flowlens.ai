import type {
  EndpointDetail,
  EndpointGraph,
  EndpointSummary,
  FlowRunDetail,
  FlowRunSummary,
  GraphEdge,
  GraphNode,
  ServiceSummary,
} from "@flowlens/shared-types";
import type { Pool } from "pg";
import { isIgnoredRoutePath, isTrackedHttpMethod, normalizeRoutePath } from "../lib/path.js";

type PgRow = Record<string, unknown>;

function mapBoolean(value: unknown): boolean {
  return value === true || value === "t";
}

function canonicalizeEndpointPath(routePath: string): string {
  const normalized =
    /(^|\/):[A-Za-z_]/.test(routePath)
    ? normalizeRoutePath(routePath, routePath)
    : normalizeRoutePath(undefined, routePath);

  return normalized.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":id");
}

function deriveCacheStrategy(
  hasCacheReads: boolean,
  hasDbReads: boolean,
): EndpointSummary["cacheStrategy"] {
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

function isTrackedEndpointRow(row: Record<string, unknown>): boolean {
  return (
    isTrackedHttpMethod(String(row.method ?? "")) &&
    !isIgnoredRoutePath(String(row.route_path ?? ""), String(row.route_path ?? ""))
  );
}

function mapGraphNode(row: Record<string, unknown>): GraphNode {
  return {
    id: String(row.id),
    key: String(row.node_key),
    nodeType: row.node_type as GraphNode["nodeType"],
    label: String(row.label),
    operationKind: row.operation_kind as GraphNode["operationKind"],
    observationType: row.observation_type as GraphNode["observationType"],
    confidence: Number(row.confidence),
    isWrite: mapBoolean(row.is_write),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    sequenceIndex: Number(row.sequence_index),
  };
}

function mapGraphEdge(row: Record<string, unknown>): GraphEdge {
  return {
    id: String(row.id),
    from: String(row.from_node_key),
    to: String(row.to_node_key),
    edgeType: row.edge_type as GraphEdge["edgeType"],
    observationType: row.observation_type as GraphEdge["observationType"],
    confidence: Number(row.confidence),
    occurrenceCount: Number(row.occurrence_count),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

function mapEndpoint(row: Record<string, unknown>): EndpointSummary {
  const routePath = String(row.route_path);
  const hasCacheReads = mapBoolean(row.has_cache_reads);
  const hasDbReads = mapBoolean(row.has_db_reads);

  return {
    id: String(row.id),
    serviceId: String(row.service_id),
    method: String(row.method),
    routePath,
    normalizedPath: canonicalizeEndpointPath(routePath),
    hasCacheReads,
    hasDbReads,
    hasWrites: mapBoolean(row.has_writes),
    hasExternalCalls: mapBoolean(row.has_external_calls),
    cacheStrategy: deriveCacheStrategy(hasCacheReads, hasDbReads),
    latestStatusCode:
      row.latest_status_code === null ? null : Number(row.latest_status_code),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
  };
}

function scoreEndpoint(endpoint: EndpointSummary): number {
  let score = 0;

  if (endpoint.routePath.includes(":")) {
    score += 100;
  }

  if (/did:|did%3A/i.test(endpoint.routePath)) {
    score -= 50;
  }

  if (endpoint.routePath.split("/").some((segment) => segment.length >= 24 && !segment.startsWith(":"))) {
    score -= 25;
  }

  score -= endpoint.routePath.length / 100;
  return score;
}

function toTimestamp(value: string | null): number {
  return value ? Date.parse(value) : 0;
}

function dedupeEndpoints(rows: Record<string, unknown>[]): EndpointSummary[] {
  const deduped = new Map<string, EndpointSummary>();

  for (const row of rows.filter(isTrackedEndpointRow)) {
    const mapped = mapEndpoint(row);
    const key = `${mapped.serviceId}:${mapped.method}:${mapped.normalizedPath}`;
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, mapped);
      continue;
    }

    const preferred =
      scoreEndpoint(mapped) > scoreEndpoint(existing) ? mapped : existing;
    const latest =
      toTimestamp(mapped.lastSeenAt) >= toTimestamp(existing.lastSeenAt) ? mapped : existing;
    const hasCacheReads = existing.hasCacheReads || mapped.hasCacheReads;
    const hasDbReads = existing.hasDbReads || mapped.hasDbReads;

    deduped.set(key, {
      ...preferred,
      hasCacheReads,
      hasDbReads,
      hasWrites: existing.hasWrites || mapped.hasWrites,
      hasExternalCalls: existing.hasExternalCalls || mapped.hasExternalCalls,
      cacheStrategy: deriveCacheStrategy(hasCacheReads, hasDbReads),
      latestStatusCode: latest.latestStatusCode,
      lastSeenAt: latest.lastSeenAt,
    });
  }

  return [...deduped.values()].sort((left, right) => {
    if (left.method !== right.method) {
      return left.method.localeCompare(right.method);
    }

    return left.routePath.localeCompare(right.routePath);
  });
}

function mapFlowRun(row: Record<string, unknown>): FlowRunSummary {
  return {
    id: String(row.id),
    serviceId: String(row.service_id),
    endpointId: String(row.endpoint_id),
    requestId: String(row.request_id),
    method: String(row.method),
    routePath: String(row.route_path),
    statusCode: row.status_code === null ? null : Number(row.status_code),
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    observationState: row.observation_state as FlowRunSummary["observationState"],
  };
}

export async function listProjects(pool: Pool, schema: string) {
  const result = await pool.query(
    `SELECT id, name, root_path AS "rootPath", created_at AS "createdAt" FROM ${schema}.projects ORDER BY created_at ASC`,
  );
  return result.rows;
}

export async function listServices(
  pool: Pool,
  schema: string,
): Promise<ServiceSummary[]> {
  const servicesResult = await pool.query(
    `
      SELECT
        s.id,
        s.name,
        s.runtime,
        s.framework,
        s.sdk_version,
        s.last_seen_at
      FROM ${schema}.services s
      ORDER BY s.last_seen_at DESC, s.name ASC
    `,
  );

  const endpointsResult = await pool.query(`SELECT * FROM ${schema}.endpoints`);
  const endpointCounts = new Map<string, number>();

  for (const endpoint of dedupeEndpoints(endpointsResult.rows)) {
    endpointCounts.set(
      endpoint.serviceId,
      (endpointCounts.get(endpoint.serviceId) ?? 0) + 1,
    );
  }

  return servicesResult.rows.map((row: PgRow) => ({
    id: String(row.id),
    name: String(row.name),
    runtime: String(row.runtime),
    framework: String(row.framework),
    sdkVersion: row.sdk_version ? String(row.sdk_version) : null,
    endpointCount: endpointCounts.get(String(row.id)) ?? 0,
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
  }));
}

export async function listEndpointsByService(
  pool: Pool,
  schema: string,
  serviceId: string,
): Promise<EndpointSummary[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM ${schema}.endpoints
      WHERE service_id = $1
      ORDER BY method ASC, route_path ASC
    `,
    [serviceId],
  );

  return dedupeEndpoints(result.rows);
}

export async function getEndpointGraph(
  pool: Pool,
  schema: string,
  endpointId: string,
  view: "latest" | "aggregate",
): Promise<EndpointGraph | null> {
  if (view === "latest") {
    const snapshotResult = await pool.query(
      `
        SELECT
          latest_flow_run_id,
          graph_summary,
          cache_strategy
        FROM ${schema}.endpoint_snapshots
        WHERE endpoint_id = $1
      `,
      [endpointId],
    );

    if (snapshotResult.rowCount === 0) {
      return null;
    }

    const latestFlowRunId = snapshotResult.rows[0].latest_flow_run_id as
      | string
      | null;

    if (!latestFlowRunId) {
      return null;
    }

    const [nodesResult, edgesResult, endpointResult] = await Promise.all([
      pool.query(
        `
          SELECT *
          FROM ${schema}.flow_nodes
          WHERE flow_run_id = $1
          ORDER BY sequence_index ASC, label ASC
        `,
        [latestFlowRunId],
      ),
      pool.query(
        `
          SELECT *
          FROM ${schema}.flow_edges
          WHERE flow_run_id = $1
          ORDER BY id ASC
        `,
        [latestFlowRunId],
      ),
      pool.query(
        `SELECT * FROM ${schema}.endpoints WHERE id = $1`,
        [endpointId],
      ),
    ]);

    if (endpointResult.rowCount === 0) {
      return null;
    }

    const endpoint = mapEndpoint(endpointResult.rows[0]);

    return {
      endpointId,
      snapshotKind: "latest",
      generatedAt: new Date().toISOString(),
      nodes: nodesResult.rows.map(mapGraphNode),
      edges: edgesResult.rows.map(mapGraphEdge),
      summary: {
        cacheStrategy: endpoint.cacheStrategy,
        writesData: endpoint.hasWrites,
        hasCacheReads: endpoint.hasCacheReads,
        hasDbReads: endpoint.hasDbReads,
        hasExternalCalls: endpoint.hasExternalCalls,
      },
    };
  }

  const [nodesResult, edgesResult, endpointResult] = await Promise.all([
    pool.query(
      `
        SELECT *
        FROM ${schema}.flow_nodes
        WHERE endpoint_id = $1 AND snapshot_kind = 'aggregate'
        ORDER BY sequence_index ASC, label ASC
      `,
      [endpointId],
    ),
    pool.query(
      `
        SELECT *
        FROM ${schema}.flow_edges
        WHERE endpoint_id = $1 AND snapshot_kind = 'aggregate'
        ORDER BY occurrence_count DESC, id ASC
      `,
      [endpointId],
    ),
    pool.query(`SELECT * FROM ${schema}.endpoints WHERE id = $1`, [endpointId]),
  ]);

  if (endpointResult.rowCount === 0) {
    return null;
  }

  const endpoint = mapEndpoint(endpointResult.rows[0]);

  return {
    endpointId,
    snapshotKind: "aggregate",
    generatedAt: new Date().toISOString(),
    nodes: nodesResult.rows.map(mapGraphNode),
    edges: edgesResult.rows.map(mapGraphEdge),
    summary: {
      cacheStrategy: endpoint.cacheStrategy,
      writesData: endpoint.hasWrites,
      hasCacheReads: endpoint.hasCacheReads,
      hasDbReads: endpoint.hasDbReads,
      hasExternalCalls: endpoint.hasExternalCalls,
    },
  };
}

export async function listRunsByEndpoint(
  pool: Pool,
  schema: string,
  endpointId: string,
): Promise<FlowRunSummary[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM ${schema}.flow_runs
      WHERE endpoint_id = $1
      ORDER BY started_at DESC
      LIMIT 25
    `,
    [endpointId],
  );

  return result.rows.map(mapFlowRun);
}

export async function getFlowRunDetail(
  pool: Pool,
  schema: string,
  runId: string,
): Promise<FlowRunDetail | null> {
  const runResult = await pool.query(
    `SELECT * FROM ${schema}.flow_runs WHERE id = $1`,
    [runId],
  );

  if (runResult.rowCount === 0) {
    return null;
  }

  const run = runResult.rows[0];
  const flowSummary = mapFlowRun(run);

  const [eventsResult, nodesResult, edgesResult] = await Promise.all([
    pool.query(
      `
        SELECT payload
        FROM ${schema}.runtime_events
        WHERE flow_run_id = $1
        ORDER BY sequence_no ASC NULLS LAST, observed_at ASC, id ASC
      `,
      [runId],
    ),
    pool.query(
      `
        SELECT *
        FROM ${schema}.flow_nodes
        WHERE flow_run_id = $1
        ORDER BY sequence_index ASC, label ASC
      `,
      [runId],
    ),
    pool.query(
      `
        SELECT *
        FROM ${schema}.flow_edges
        WHERE flow_run_id = $1
        ORDER BY id ASC
      `,
      [runId],
    ),
  ]);

  return {
    ...flowSummary,
    rawPath: run.raw_path ? String(run.raw_path) : undefined,
    redaction: (run.redaction as FlowRunDetail["redaction"]) ?? null,
    timeline: eventsResult.rows.map((row: PgRow) => row.payload as FlowRunDetail["timeline"][number]),
    graph: {
      endpointId: flowSummary.endpointId,
      snapshotKind: "latest",
      generatedAt: new Date().toISOString(),
      nodes: nodesResult.rows.map(mapGraphNode),
      edges: edgesResult.rows.map(mapGraphEdge),
      summary: {
        cacheStrategy: "unknown",
        writesData: nodesResult.rows.some((row: PgRow) => mapBoolean(row.is_write)),
        hasCacheReads: nodesResult.rows.some(
          (row: PgRow) =>
            row.node_type === "redis" &&
            row.operation_kind === "read",
        ),
        hasDbReads: nodesResult.rows.some(
          (row: PgRow) =>
            row.node_type === "postgresql" &&
            row.operation_kind === "read",
        ),
        hasExternalCalls: nodesResult.rows.some(
          (row: PgRow) => row.node_type === "external-service",
        ),
      },
    },
  };
}

export async function getEndpointDetail(
  pool: Pool,
  schema: string,
  endpointId: string,
): Promise<EndpointDetail | null> {
  const endpointResult = await pool.query(
    `SELECT * FROM ${schema}.endpoints WHERE id = $1`,
    [endpointId],
  );

  if (endpointResult.rowCount === 0) {
    return null;
  }

  const endpoint = mapEndpoint(endpointResult.rows[0]);
  const [latestGraph, aggregateGraph, recentRuns] = await Promise.all([
    getEndpointGraph(pool, schema, endpointId, "latest"),
    getEndpointGraph(pool, schema, endpointId, "aggregate"),
    listRunsByEndpoint(pool, schema, endpointId),
  ]);

  return {
    endpoint,
    latestRun: recentRuns[0] ?? null,
    latestGraph,
    aggregateGraph,
    recentRuns,
  };
}
