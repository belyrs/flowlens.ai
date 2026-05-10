import { useEffect, useState } from "react";
import type { EndpointDetail, EndpointGraph } from "@flowlens/shared-types";
import { Link, useParams } from "react-router-dom";
import { fetchEndpointDetail, fetchEndpointGraph } from "../api/client";
import { EmptyState } from "../components/empty-state";
import { GraphCanvas } from "../components/graph-canvas";
import { Shell } from "../components/shell";
import { StatusBadge } from "../components/status-badge";

function getResponseLabel(graph: EndpointGraph | null): string {
  const responseNode = graph?.nodes.find((node) => node.nodeType === "response");

  return responseNode?.label ?? "—";
}

export function EndpointDetailPage() {
  const { endpointId = "" } = useParams();
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [graphView, setGraphView] = useState<"latest" | "aggregate">("latest");
  const [graph, setGraph] = useState<EndpointGraph | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    void fetchEndpointDetail(endpointId)
      .then((result) => {
        setDetail(result);
        setGraph(result.latestGraph ?? result.aggregateGraph ?? null);
      })
      .finally(() => setLoading(false));
  }, [endpointId]);

  useEffect(() => {
    void fetchEndpointGraph(endpointId, graphView)
      .then((result) => setGraph(result))
      .catch(() => {
        setGraph(graphView === "latest" ? detail?.latestGraph ?? null : detail?.aggregateGraph ?? null);
      });
  }, [detail, endpointId, graphView]);

  if (loading) {
    return (
      <Shell
        title="Endpoint"
        subtitle="Loading endpoint flow…"
      >
        <div className="panel">Loading…</div>
      </Shell>
    );
  }

  if (!detail) {
    return (
      <Shell
        title="Endpoint"
        subtitle="Endpoint could not be found."
      >
        <EmptyState
          title="Endpoint not found"
          description="This endpoint may not have been observed yet."
        />
      </Shell>
    );
  }

  return (
    <Shell
      title={`${detail.endpoint.method} ${detail.endpoint.routePath}`}
      subtitle="Understand how the endpoint moves through cache, database, and response layers without opening the service code."
      actions={
        <div className="segmented-control">
          <button
            className={graphView === "latest" ? "active" : ""}
            onClick={() => setGraphView("latest")}
          >
            Latest run
          </button>
          <button
            className={graphView === "aggregate" ? "active" : ""}
            onClick={() => setGraphView("aggregate")}
          >
            Aggregate
          </button>
        </div>
      }
    >
      <div className="summary-grid">
        <div className="panel metric-card">
          <p className="metric-label">Cache strategy</p>
          <h3>{detail.endpoint.cacheStrategy}</h3>
          <div className="badge-row">
            {detail.endpoint.hasCacheReads ? (
              <StatusBadge tone="cache">Redis observed</StatusBadge>
            ) : null}
            {detail.endpoint.hasDbReads ? <StatusBadge tone="db">PostgreSQL observed</StatusBadge> : null}
          </div>
        </div>
        <div className="panel metric-card">
          <p className="metric-label">Writes data</p>
          <h3>{detail.endpoint.hasWrites ? "Yes" : "No"}</h3>
          <div className="badge-row">
            {detail.endpoint.hasWrites ? (
              <StatusBadge tone="write">Write path</StatusBadge>
            ) : (
              <StatusBadge tone="neutral">Read path</StatusBadge>
            )}
          </div>
        </div>
        <div className="panel metric-card">
          <p className="metric-label">Latest request</p>
          <h3>{getResponseLabel(detail.latestGraph)}</h3>
          <p className="metric-support">{detail.latestRun?.durationMs ?? "—"} ms</p>
        </div>
      </div>

      <GraphCanvas graph={graph} />

      <div className="content-grid">
        <section className="panel">
          <div className="section-header">
            <h3>Recent runs</h3>
          </div>
          {detail.recentRuns.length === 0 ? (
            <p>No runs captured yet.</p>
          ) : (
            <div className="run-list">
              {detail.recentRuns.map((run) => (
                <Link key={run.id} to={`/runs/${run.id}`} className="run-item">
                  <div>
                    <strong>{run.requestId}</strong>
                    <p>{run.startedAt}</p>
                  </div>
                  <div className="run-meta">
                    <StatusBadge tone="success">{String(run.statusCode ?? "—")}</StatusBadge>
                    <span>{run.durationMs ?? "—"} ms</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-header">
            <h3>What FlowLens inferred</h3>
          </div>
          <ul className="insight-list">
            <li>
              Response path: {detail.endpoint.hasCacheReads ? "cache-aware" : "database-driven"}
            </li>
            <li>
              Storage reads: {detail.endpoint.hasDbReads ? "PostgreSQL observed" : "No DB read observed"}
            </li>
            <li>
              Storage writes: {detail.endpoint.hasWrites ? "Writes happen on this endpoint" : "No writes observed"}
            </li>
          </ul>
        </section>
      </div>
    </Shell>
  );
}
