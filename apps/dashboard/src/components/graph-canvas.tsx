import type { EndpointGraph, GraphNode as FlowGraphNode } from "@flowlens/shared-types";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState, type ReactNode } from "react";

const NODE_COLORS: Record<string, string> = {
  "api-endpoint": "#62c2ff",
  redis: "#ffca7a",
  postgresql: "#8ce8a4",
  response: "#a6b0d0",
  "external-service": "#ff9db0",
};

function layoutNodes(graph: EndpointGraph) {
  const ordered = [...graph.nodes].sort((left, right) => left.sequenceIndex - right.sequenceIndex);

  return ordered.map((node, index) => ({
    id: node.key,
    data: {
      label: (
        <div className="graph-node-label">
          <strong>{node.label}</strong>
          <span>{node.operationKind}</span>
        </div>
      ),
    },
    position: {
      x: 80 + index * 250,
      y:
        node.nodeType === "api-endpoint" ? 100
        : node.nodeType === "response" ? 100
        : node.nodeType === "redis" ? 20
        : node.nodeType === "postgresql" ? 180
        : 260,
    },
    style: {
      background: NODE_COLORS[node.nodeType],
      borderRadius: 18,
      border: "1px solid rgba(10, 25, 45, 0.12)",
      color: "#102035",
      minWidth: 190,
      padding: 14,
      boxShadow: "0 10px 30px rgba(7, 15, 30, 0.08)",
    },
  }));
}

function prettyPrint(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function renderCodeSection(title: string, value: unknown, emptyText: string): ReactNode {
  const hasValue =
    value !== undefined &&
    value !== null &&
    (!(typeof value === "object" && !Array.isArray(value)) || Object.keys(value as Record<string, unknown>).length > 0);

  return (
    <section className="inspector-section">
      <h4>{title}</h4>
      {hasValue ? <pre>{prettyPrint(value)}</pre> : <p className="inspector-muted">{emptyText}</p>}
    </section>
  );
}

function renderNodeInspector(node: FlowGraphNode | null): ReactNode {
  if (!node) {
    return (
      <>
        <h3>Select a node</h3>
        <p className="inspector-copy">
          Click a graph node to inspect what FlowLens observed for that step.
        </p>
      </>
    );
  }

  const metadata = node.metadata as Record<string, unknown>;

  if (node.nodeType === "api-endpoint") {
    return (
      <>
        <h3>{node.label}</h3>
        <p className="inspector-copy">
          Request node • {String(metadata.requestId ?? "unknown request")}
        </p>
        <div className="inspector-meta">
          <span>Raw path: {String(metadata.rawPath ?? metadata.routePath ?? "—")}</span>
          <span>Content type: {String(metadata.contentType ?? "unknown")}</span>
        </div>
        {renderCodeSection("Headers", metadata.headers, "No request headers were captured.")}
        {renderCodeSection("Query", metadata.query, "No query parameters were observed.")}
        {renderCodeSection("Params", metadata.params, "No route parameters were observed.")}
        {metadata.bodyCaptured === true
          ? renderCodeSection("Body", metadata.body, "No request body was sent.")
          : (
            <section className="inspector-section">
              <h4>Body</h4>
              <p className="inspector-muted">
                Payload capture is disabled for this service. Enable `capturePayloads` to inspect exact request bodies.
              </p>
            </section>
          )}
      </>
    );
  }

  if (node.nodeType === "response") {
    return (
      <>
        <h3>{node.label}</h3>
        <p className="inspector-copy">
          Response node • confidence {node.confidence.toFixed(2)}
        </p>
        <div className="inspector-meta">
          <span>Status: {String(metadata.statusCode ?? "—")}</span>
          <span>Message: {String(metadata.statusMessage ?? "unknown")}</span>
          <span>Duration: {String(metadata.durationMs ?? "—")} ms</span>
        </div>
        {renderCodeSection("Response metadata", metadata, "No response metadata was captured.")}
      </>
    );
  }

  if (node.nodeType === "postgresql") {
    return (
      <>
        <h3>{node.label}</h3>
        <p className="inspector-copy">
          PostgreSQL • {node.operationKind} • confidence {node.confidence.toFixed(2)}
        </p>
        <div className="inspector-meta">
          <span>Operation: {String(metadata.operation ?? "UNKNOWN")}</span>
          <span>Tables: {Array.isArray(metadata.tables) ? metadata.tables.join(", ") || "unknown" : "unknown"}</span>
        </div>
        {renderCodeSection("SQL", metadata.normalizedSql, "No SQL text was normalized for this query.")}
      </>
    );
  }

  if (node.nodeType === "redis") {
    return (
      <>
        <h3>{node.label}</h3>
        <p className="inspector-copy">
          Redis • {node.operationKind} • confidence {node.confidence.toFixed(2)}
        </p>
        <div className="inspector-meta">
          <span>Command: {String(metadata.command ?? "unknown")}</span>
          <span>Namespace: {String(metadata.keyNamespace ?? "unknown")}</span>
        </div>
        {renderCodeSection("Key reference", { keyHash: metadata.keyHash }, "No cache key details were captured.")}
      </>
    );
  }

  if (node.nodeType === "external-service") {
    return (
      <>
        <h3>{node.label}</h3>
        <p className="inspector-copy">
          External interaction • confidence {node.confidence.toFixed(2)}
        </p>
        <div className="inspector-meta">
          <span>Transport: {String(metadata.transport ?? "http")}</span>
          <span>Target: {String(metadata.host ?? metadata.serviceName ?? "unknown")}</span>
          <span>Status: {String(metadata.statusCode ?? "unknown")}</span>
        </div>
        {renderCodeSection("Call details", metadata, "No external call details were captured.")}
      </>
    );
  }

  return (
    <>
      <h3>{node.label}</h3>
      <p className="inspector-copy">
        {node.nodeType} • {node.observationType} • confidence {node.confidence.toFixed(2)}
      </p>
      {renderCodeSection("Metadata", metadata, "No metadata was captured for this node.")}
    </>
  );
}

interface GraphCanvasProps {
  graph: EndpointGraph | null;
}

function GraphCanvasInner({ graph }: GraphCanvasProps) {
  const initialNodes = useMemo(() => (graph ? layoutNodes(graph) : []), [graph]);
  const initialEdges = useMemo(
    () =>
      graph
        ? graph.edges.map((edge) => ({
            id: edge.id,
            source: edge.from,
            target: edge.to,
            animated: edge.edgeType === "cache-fallback",
            label:
              edge.edgeType === "cache-fallback"
                ? "fallback"
                : edge.edgeType === "response"
                  ? "response"
                  : undefined,
            markerEnd: {
              type: MarkerType.ArrowClosed,
            },
            style: {
              stroke: edge.observationType === "observed" ? "#21416a" : "#7586a5",
              strokeDasharray: edge.observationType === "observed" ? undefined : "6 4",
            },
            labelStyle: {
              fill: "#21416a",
              fontSize: 11,
            },
          }))
        : [],
    [graph],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);

  useEffect(() => {
    setSelectedNodeKey(graph?.nodes.find((node) => node.nodeType === "api-endpoint")?.key ?? null);
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [graph, initialEdges, initialNodes, setEdges, setNodes]);

  const selectedNode = graph?.nodes.find((node) => node.key === selectedNodeKey) ?? null;

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="panel graph-empty">
        <p>No graph has been observed for this endpoint yet.</p>
      </div>
    );
  }

  return (
    <div className="graph-layout">
      <div className="graph-panel panel">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => setSelectedNodeKey(node.id)}
          fitView
          fitViewOptions={{ padding: 0.18 }}
        >
          <Background color="rgba(33, 65, 106, 0.08)" gap={28} />
          <Controls />
        </ReactFlow>
      </div>

      <aside className="panel inspector">
        {renderNodeInspector(selectedNode)}
      </aside>
    </div>
  );
}

export function GraphCanvas({ graph }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner graph={graph} />
    </ReactFlowProvider>
  );
}
