import type { RuntimeEventBatch } from "@flowlens/shared-types";
import { Router } from "express";
import type { Pool } from "pg";
import { getEndpointDetail, getEndpointGraph, getFlowRunDetail, listEndpointsByService, listProjects, listRunsByEndpoint, listServices } from "../db/queries.js";
import { persistBatch } from "../ingest/persist-batch.js";
import { asyncHandler } from "../lib/http.js";

interface RouteDependencies {
  pool: Pool;
  schema: string;
}

function singleParam(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }

  return typeof value === "string" ? value : "";
}

export function createApiRouter({ pool, schema }: RouteDependencies): Router {
  const router = Router();

  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      res.json({ status: "ok" });
    }),
  );

  router.post(
    "/api/v1/events/batch",
    asyncHandler(async (req, res) => {
      const batch = req.body as RuntimeEventBatch;
      const result = await persistBatch(pool, schema, batch);

      res.status(202).json({
        accepted: true,
        serviceId: result.serviceId,
        requestIds: result.requestIds,
      });
    }),
  );

  router.get(
    "/api/v1/projects",
    asyncHandler(async (_req, res) => {
      const projects = await listProjects(pool, schema);
      res.json({ projects });
    }),
  );

  router.get(
    "/api/v1/services",
    asyncHandler(async (_req, res) => {
      const services = await listServices(pool, schema);
      res.json({ services });
    }),
  );

  router.get(
    "/api/v1/services/:serviceId/endpoints",
    asyncHandler(async (req, res) => {
      const endpoints = await listEndpointsByService(
        pool,
        schema,
        singleParam(req.params.serviceId),
      );
      res.json({ endpoints });
    }),
  );

  router.get(
    "/api/v1/endpoints/:endpointId",
    asyncHandler(async (req, res) => {
      const detail = await getEndpointDetail(
        pool,
        schema,
        singleParam(req.params.endpointId),
      );

      if (!detail) {
        res.status(404).json({ error: "Endpoint not found" });
        return;
      }

      res.json(detail);
    }),
  );

  router.get(
    "/api/v1/endpoints/:endpointId/graph",
    asyncHandler(async (req, res) => {
      const view = singleParam(req.query.view) === "aggregate" ? "aggregate" : "latest";
      const graph = await getEndpointGraph(
        pool,
        schema,
        singleParam(req.params.endpointId),
        view,
      );

      if (!graph) {
        res.status(404).json({ error: "Graph not found" });
        return;
      }

      res.json(graph);
    }),
  );

  router.get(
    "/api/v1/endpoints/:endpointId/runs",
    asyncHandler(async (req, res) => {
      const runs = await listRunsByEndpoint(
        pool,
        schema,
        singleParam(req.params.endpointId),
      );
      res.json({ runs });
    }),
  );

  router.get(
    "/api/v1/flow-runs/:runId",
    asyncHandler(async (req, res) => {
      const detail = await getFlowRunDetail(pool, schema, singleParam(req.params.runId));

      if (!detail) {
        res.status(404).json({ error: "Flow run not found" });
        return;
      }

      res.json(detail);
    }),
  );

  return router;
}
