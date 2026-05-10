import type { Pool } from "pg";

export async function ensureSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.services (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ${schema}.projects (id),
      name TEXT NOT NULL UNIQUE,
      runtime TEXT NOT NULL,
      framework TEXT NOT NULL,
      sdk_version TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.endpoints (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES ${schema}.services (id),
      method TEXT NOT NULL,
      route_path TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      has_cache_reads BOOLEAN NOT NULL DEFAULT FALSE,
      has_db_reads BOOLEAN NOT NULL DEFAULT FALSE,
      has_writes BOOLEAN NOT NULL DEFAULT FALSE,
      has_external_calls BOOLEAN NOT NULL DEFAULT FALSE,
      cache_strategy TEXT NOT NULL DEFAULT 'unknown',
      latest_status_code INTEGER,
      UNIQUE (service_id, method, route_path)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.flow_runs (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES ${schema}.services (id),
      endpoint_id TEXT NOT NULL REFERENCES ${schema}.endpoints (id),
      request_id TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      route_path TEXT NOT NULL,
      raw_path TEXT,
      status_code INTEGER,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      duration_ms NUMERIC,
      observation_state TEXT NOT NULL,
      redaction JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.runtime_events (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES ${schema}.services (id),
      flow_run_id TEXT REFERENCES ${schema}.flow_runs (id),
      request_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      sequence_no INTEGER,
      payload JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.flow_nodes (
      id TEXT PRIMARY KEY,
      flow_run_id TEXT REFERENCES ${schema}.flow_runs (id),
      endpoint_id TEXT NOT NULL REFERENCES ${schema}.endpoints (id),
      snapshot_kind TEXT,
      node_key TEXT NOT NULL,
      node_type TEXT NOT NULL,
      label TEXT NOT NULL,
      operation_kind TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      confidence NUMERIC NOT NULL,
      is_write BOOLEAN NOT NULL DEFAULT FALSE,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      sequence_index INTEGER NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.flow_edges (
      id TEXT PRIMARY KEY,
      flow_run_id TEXT REFERENCES ${schema}.flow_runs (id),
      endpoint_id TEXT NOT NULL REFERENCES ${schema}.endpoints (id),
      snapshot_kind TEXT,
      from_node_key TEXT NOT NULL,
      to_node_key TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      confidence NUMERIC NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.endpoint_snapshots (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL UNIQUE REFERENCES ${schema}.endpoints (id),
      latest_flow_run_id TEXT REFERENCES ${schema}.flow_runs (id),
      graph_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      cache_strategy TEXT NOT NULL DEFAULT 'unknown',
      writes_data BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
}

