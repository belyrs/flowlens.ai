import { useEffect, useState } from "react";
import type { FlowRunDetail } from "@flowlens/shared-types";
import { useParams } from "react-router-dom";
import { fetchFlowRunDetail } from "../api/client";
import { GraphCanvas } from "../components/graph-canvas";
import { Shell } from "../components/shell";
import { StatusBadge } from "../components/status-badge";

function getResponseLabel(detail: FlowRunDetail): string {
  const responseNode = detail.graph.nodes.find((node) => node.nodeType === "response");
  return responseNode?.label ?? String(detail.statusCode ?? "—");
}

export function RunDetailPage() {
  const { runId = "" } = useParams();
  const [detail, setDetail] = useState<FlowRunDetail | null>(null);

  useEffect(() => {
    void fetchFlowRunDetail(runId).then(setDetail);
  }, [runId]);

  if (!detail) {
    return (
      <Shell title="Request flow" subtitle="Loading concrete request execution…">
        <div className="panel">Loading…</div>
      </Shell>
    );
  }

  return (
    <Shell
      title={`Request ${detail.requestId}`}
      subtitle={`${detail.method} ${detail.routePath} • ${getResponseLabel(detail)} • ${detail.durationMs ?? "—"} ms`}
    >
      <div className="summary-grid">
        <div className="panel metric-card">
          <p className="metric-label">Observation state</p>
          <h3>{detail.observationState}</h3>
        </div>
        <div className="panel metric-card">
          <p className="metric-label">Status code</p>
          <h3>{getResponseLabel(detail)}</h3>
        </div>
        <div className="panel metric-card">
          <p className="metric-label">Redaction</p>
          <h3>{detail.redaction?.payloadCaptured ? "Payload opt-in" : "Safe default"}</h3>
        </div>
      </div>

      <GraphCanvas graph={detail.graph} />

      <div className="content-grid">
        <section className="panel">
          <div className="section-header">
            <h3>Timeline</h3>
          </div>
          <div className="timeline-list">
            {detail.timeline.map((event) => (
              <div key={event.id} className="timeline-item">
                <div>
                  <strong>{event.type}</strong>
                  <p>{event.observedAt}</p>
                </div>
                <div className="run-meta">
                  <StatusBadge tone="neutral">
                    {event.durationMs ? `${event.durationMs} ms` : "event"}
                  </StatusBadge>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="section-header">
            <h3>Runtime notes</h3>
          </div>
          <ul className="insight-list">
            <li>Authorization headers are redacted by default.</li>
            <li>Request payloads are not stored unless payload capture is enabled.</li>
            <li>Redis keys are represented as namespaces plus hashed references.</li>
          </ul>
        </section>
      </div>
    </Shell>
  );
}
