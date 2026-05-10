import type {
  GraphEdge,
  GraphNode,
  RuntimeEvent,
  RuntimeEventBatch,
} from "@flowlens/shared-types";
import type { Pool, PoolClient } from "pg";
import { createId } from "../lib/ids.js";
import { isIgnoredRoutePath, isTrackedHttpMethod, normalizeRoutePath } from "../lib/path.js";
import { projectAggregateGraph, projectRunGraph } from "../graph/projector.js";

interface PersistResult {
  serviceId: string;
  requestIds: string[];
}

type PgRow = Record<string, unknown>;

function getEndpointFingerprint(event: RuntimeEvent) {
  const method = (event.request.method ?? "GET").toUpperCase();
  const routePath = normalizeRoutePath(event.request.routePath, event.request.path);

  return {
    method,
    routePath,
  };
}

function shouldTrackEndpoint(event: RuntimeEvent): boolean {
  return (
    isTrackedHttpMethod(event.request.method) &&
    !isIgnoredRoutePath(event.request.routePath, event.request.path)
  );
}

function pickRedaction(events: RuntimeEvent[]) {
  return events.find((event) => event.redaction)?.redaction ?? null;
}

function summarizeRunNodes(nodes: Array<{
  nodeType: string;
  operationKind: string;
  isWrite: boolean;
}>){
  const hasCacheReads = nodes.some(
    (node) => node.nodeType === "redis" && node.operationKind === "read",
  );
  const hasDbReads = nodes.some(
    (node) => node.nodeType === "postgresql" && node.operationKind === "read",
  );

  return {
    cacheStrategy:
      hasCacheReads && hasDbReads ? "cache-then-db"
      : hasCacheReads ? "cache-only"
      : hasDbReads ? "db-only"
      : "unknown",
    writesData: nodes.some((node) => node.isWrite),
    hasCacheReads,
    hasDbReads,
    hasExternalCalls: nodes.some((node) => node.nodeType === "external-service"),
  } as const;
}

async function ensureDefaultProject(
  client: PoolClient,
  schema: string,
): Promise<string> {
  const projectId = "project_default";

  await client.query(
    `
      INSERT INTO ${schema}.projects (id, name, root_path)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [projectId, "Local FlowLens Project", null],
  );

  return projectId;
}

async function ensureService(
  client: PoolClient,
  schema: string,
  batch: RuntimeEventBatch,
): Promise<string> {
  const projectId = await ensureDefaultProject(client, schema);
  const serviceId = `service_${batch.service.name}`;
  const now = new Date().toISOString();

  await client.query(
    `
      INSERT INTO ${schema}.services (
        id,
        project_id,
        name,
        runtime,
        framework,
        sdk_version,
        first_seen_at,
        last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      ON CONFLICT (name) DO UPDATE
      SET
        runtime = EXCLUDED.runtime,
        framework = EXCLUDED.framework,
        sdk_version = EXCLUDED.sdk_version,
        last_seen_at = EXCLUDED.last_seen_at
    `,
    [
      serviceId,
      projectId,
      batch.service.name,
      batch.service.runtime,
      batch.service.framework,
      batch.sdk.version,
      now,
    ],
  );

  return serviceId;
}

async function ensureEndpoint(
  client: PoolClient,
  schema: string,
  serviceId: string,
  event: RuntimeEvent,
): Promise<string> {
  const { method, routePath } = getEndpointFingerprint(event);
  const normalizedPath = normalizeRoutePath(routePath, event.request.path);
  const endpointId = `endpoint_${serviceId}_${method}_${routePath}`.replaceAll("/", "_");
  const now = new Date().toISOString();

  await client.query(
    `
      INSERT INTO ${schema}.endpoints (
        id,
        service_id,
        method,
        route_path,
        normalized_path,
        first_seen_at,
        last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $6)
      ON CONFLICT (service_id, method, route_path) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at
    `,
    [
      endpointId,
      serviceId,
      method,
      routePath,
      normalizedPath,
      now,
    ],
  );

  return endpointId;
}

function validateBatch(batch: RuntimeEventBatch): void {
  if (!batch.events || batch.events.length === 0) {
    throw new Error("Batch must include at least one event");
  }

  if (!batch.service?.name) {
    throw new Error("Batch must include a service name");
  }
}

async function insertEvents(
  client: PoolClient,
  schema: string,
  serviceId: string,
  batch: RuntimeEventBatch,
): Promise<string[]> {
  const touchedRequestIds = new Set<string>();

  for (const event of batch.events) {
    if (!event.request?.id) {
      continue;
    }

    touchedRequestIds.add(event.request.id);

    await client.query(
      `
        INSERT INTO ${schema}.runtime_events (
          id,
          service_id,
          request_id,
          event_type,
          observed_at,
          sequence_no,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        event.id,
        serviceId,
        event.request.id,
        event.type,
        event.observedAt,
        event.sequenceNo ?? null,
        JSON.stringify(event),
      ],
    );
  }

  return [...touchedRequestIds];
}

async function finalizeRequest(
  client: PoolClient,
  schema: string,
  serviceId: string,
  requestId: string,
): Promise<void> {
  const eventsResult = await client.query(
    `
      SELECT payload
      FROM ${schema}.runtime_events
      WHERE request_id = $1 AND service_id = $2
      ORDER BY sequence_no ASC NULLS LAST, observed_at ASC, id ASC
    `,
    [requestId, serviceId],
  );

  const events = eventsResult.rows.map((row: PgRow) => row.payload as RuntimeEvent);

  if (events.length === 0) {
    return;
  }

  const started = events.find((event) => event.type === "request.started");
  const finished = [...events].reverse().find((event) => event.type === "request.finished");

  if (!started || !finished) {
    return;
  }

  if (!shouldTrackEndpoint(finished)) {
    return;
  }

  const { method, routePath } = getEndpointFingerprint(finished);
  const endpointId = await ensureEndpoint(client, schema, serviceId, finished);
  const flowRunId = `flow_${requestId}`;
  const graph = projectRunGraph({
    endpointId,
    method,
    routePath,
    events,
  });
  const observationState = events.some((event) => event.observationType !== "observed")
    ? "incomplete"
    : "observed";

  await client.query(
    `
      INSERT INTO ${schema}.flow_runs (
        id,
        service_id,
        endpoint_id,
        request_id,
        method,
        route_path,
        raw_path,
        status_code,
        started_at,
        ended_at,
        duration_ms,
        observation_state,
        redaction
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      ON CONFLICT (request_id) DO UPDATE
      SET
        endpoint_id = EXCLUDED.endpoint_id,
        status_code = EXCLUDED.status_code,
        ended_at = EXCLUDED.ended_at,
        duration_ms = EXCLUDED.duration_ms,
        observation_state = EXCLUDED.observation_state,
        redaction = EXCLUDED.redaction
    `,
    [
      flowRunId,
      serviceId,
      endpointId,
      requestId,
      method,
      routePath,
      finished.request.path ?? started.request.path ?? null,
      finished.statusCode ?? finished.response?.statusCode ?? null,
      started.observedAt,
      finished.observedAt,
      finished.durationMs ?? null,
      observationState,
      JSON.stringify(pickRedaction(events)),
    ],
  );

  await client.query(
    `UPDATE ${schema}.runtime_events SET flow_run_id = $1 WHERE request_id = $2`,
    [flowRunId, requestId],
  );

  await client.query(`DELETE FROM ${schema}.flow_nodes WHERE flow_run_id = $1`, [flowRunId]);
  await client.query(`DELETE FROM ${schema}.flow_edges WHERE flow_run_id = $1`, [flowRunId]);

  for (const node of graph.nodes) {
    await client.query(
      `
        INSERT INTO ${schema}.flow_nodes (
          id,
          flow_run_id,
          endpoint_id,
          snapshot_kind,
          node_key,
          node_type,
          label,
          operation_kind,
          observation_type,
          confidence,
          is_write,
          metadata,
          sequence_index
        )
        VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      `,
      [
        node.id,
        flowRunId,
        endpointId,
        node.key,
        node.nodeType,
        node.label,
        node.operationKind,
        node.observationType,
        node.confidence,
        node.isWrite,
        JSON.stringify(node.metadata),
        node.sequenceIndex,
      ],
    );
  }

  for (const edge of graph.edges) {
    await client.query(
      `
        INSERT INTO ${schema}.flow_edges (
          id,
          flow_run_id,
          endpoint_id,
          snapshot_kind,
          from_node_key,
          to_node_key,
          edge_type,
          observation_type,
          confidence,
          occurrence_count,
          metadata
        )
        VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10::jsonb)
      `,
      [
        edge.id,
        flowRunId,
        endpointId,
        edge.from,
        edge.to,
        edge.edgeType,
        edge.observationType,
        edge.confidence,
        edge.occurrenceCount,
        JSON.stringify(edge.metadata),
      ],
    );
  }

  const runGraphsResult = await client.query(
    `
      SELECT id
      FROM ${schema}.flow_runs
      WHERE endpoint_id = $1
      ORDER BY started_at DESC
      LIMIT 50
    `,
    [endpointId],
  );

  const runGraphs: Parameters<typeof projectAggregateGraph>[1] = [];

  for (const row of runGraphsResult.rows as PgRow[]) {
    const nodesResult = await client.query(
      `
        SELECT *
        FROM ${schema}.flow_nodes
        WHERE flow_run_id = $1
        ORDER BY sequence_index ASC, id ASC
      `,
      [row.id],
    );
    const edgesResult = await client.query(
      `
        SELECT *
        FROM ${schema}.flow_edges
        WHERE flow_run_id = $1
        ORDER BY id ASC
      `,
      [row.id],
    );

    runGraphs.push({
      endpointId,
      snapshotKind: "latest" as const,
      generatedAt: new Date().toISOString(),
      nodes: nodesResult.rows.map((nodeRow: PgRow): GraphNode => ({
        id: String(nodeRow.id),
        key: String(nodeRow.node_key),
        nodeType: nodeRow.node_type as GraphNode["nodeType"],
        label: String(nodeRow.label),
        operationKind: nodeRow.operation_kind as GraphNode["operationKind"],
        observationType: nodeRow.observation_type as GraphNode["observationType"],
        confidence: Number(nodeRow.confidence),
        isWrite: nodeRow.is_write === true || nodeRow.is_write === "t",
        metadata: (nodeRow.metadata as Record<string, unknown>) ?? {},
        sequenceIndex: Number(nodeRow.sequence_index),
      })),
      edges: edgesResult.rows.map((edgeRow: PgRow): GraphEdge => ({
        id: String(edgeRow.id),
        from: String(edgeRow.from_node_key),
        to: String(edgeRow.to_node_key),
        edgeType: edgeRow.edge_type as GraphEdge["edgeType"],
        observationType: edgeRow.observation_type as GraphEdge["observationType"],
        confidence: Number(edgeRow.confidence),
        occurrenceCount: Number(edgeRow.occurrence_count),
        metadata: (edgeRow.metadata as Record<string, unknown>) ?? {},
      })),
      summary: summarizeRunNodes(
        nodesResult.rows.map((nodeRow: PgRow) => ({
          nodeType: String(nodeRow.node_type),
          operationKind: String(nodeRow.operation_kind),
          isWrite: nodeRow.is_write === true || nodeRow.is_write === "t",
        })),
      ),
    });
  }

  const aggregateGraph = projectAggregateGraph(endpointId, runGraphs);

  await client.query(
    `DELETE FROM ${schema}.flow_nodes WHERE endpoint_id = $1 AND snapshot_kind = 'aggregate'`,
    [endpointId],
  );
  await client.query(
    `DELETE FROM ${schema}.flow_edges WHERE endpoint_id = $1 AND snapshot_kind = 'aggregate'`,
    [endpointId],
  );

  for (const node of aggregateGraph.nodes) {
    await client.query(
      `
        INSERT INTO ${schema}.flow_nodes (
          id,
          flow_run_id,
          endpoint_id,
          snapshot_kind,
          node_key,
          node_type,
          label,
          operation_kind,
          observation_type,
          confidence,
          is_write,
          metadata,
          sequence_index
        )
        VALUES ($1, NULL, $2, 'aggregate', $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
      `,
      [
        node.id,
        endpointId,
        node.key,
        node.nodeType,
        node.label,
        node.operationKind,
        node.observationType,
        node.confidence,
        node.isWrite,
        JSON.stringify(node.metadata),
        node.sequenceIndex,
      ],
    );
  }

  for (const edge of aggregateGraph.edges) {
    await client.query(
      `
        INSERT INTO ${schema}.flow_edges (
          id,
          flow_run_id,
          endpoint_id,
          snapshot_kind,
          from_node_key,
          to_node_key,
          edge_type,
          observation_type,
          confidence,
          occurrence_count,
          metadata
        )
        VALUES ($1, NULL, $2, 'aggregate', $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        edge.id,
        endpointId,
        edge.from,
        edge.to,
        edge.edgeType,
        edge.observationType,
        edge.confidence,
        edge.occurrenceCount,
        JSON.stringify(edge.metadata),
      ],
    );
  }

  await client.query(
    `
      INSERT INTO ${schema}.endpoint_snapshots (
        id,
        endpoint_id,
        latest_flow_run_id,
        graph_summary,
        cache_strategy,
        writes_data,
        updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
      ON CONFLICT (endpoint_id) DO UPDATE
      SET
        latest_flow_run_id = EXCLUDED.latest_flow_run_id,
        graph_summary = EXCLUDED.graph_summary,
        cache_strategy = EXCLUDED.cache_strategy,
        writes_data = EXCLUDED.writes_data,
        updated_at = EXCLUDED.updated_at
    `,
    [
      `snapshot_${endpointId}`,
      endpointId,
      flowRunId,
      JSON.stringify(aggregateGraph.summary),
      aggregateGraph.summary.cacheStrategy,
      aggregateGraph.summary.writesData,
    ],
  );

  await client.query(
    `
      UPDATE ${schema}.endpoints
      SET
        has_cache_reads = $2,
        has_db_reads = $3,
        has_writes = $4,
        has_external_calls = $5,
        cache_strategy = $6,
        latest_status_code = $7,
        last_seen_at = NOW()
      WHERE id = $1
    `,
    [
      endpointId,
      aggregateGraph.summary.hasCacheReads,
      aggregateGraph.summary.hasDbReads,
      aggregateGraph.summary.writesData,
      aggregateGraph.summary.hasExternalCalls,
      aggregateGraph.summary.cacheStrategy,
      finished.statusCode ?? null,
    ],
  );
}

export async function persistBatch(
  pool: Pool,
  schema: string,
  batch: RuntimeEventBatch,
): Promise<PersistResult> {
  validateBatch(batch);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const serviceId = await ensureService(client, schema, batch);
    const requestIds = await insertEvents(client, schema, serviceId, batch);
    const finishedRequestIds = new Set(
      batch.events
        .filter((event) => event.type === "request.finished")
        .map((event) => event.request.id),
    );

    for (const requestId of requestIds) {
      if (finishedRequestIds.has(requestId)) {
        await finalizeRequest(client, schema, serviceId, requestId);
      }
    }

    await client.query("COMMIT");

    return {
      serviceId,
      requestIds,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
