import { useEffect, useMemo, useState } from "react";
import type { EndpointSummary } from "@flowlens/shared-types";
import { Link, useParams } from "react-router-dom";
import { fetchEndpoints } from "../api/client";
import { EmptyState } from "../components/empty-state";
import { Shell } from "../components/shell";
import { StatusBadge } from "../components/status-badge";

export function ServiceEndpointsPage() {
  const { serviceId = "" } = useParams();
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const loadEndpoints = () => {
      void fetchEndpoints(serviceId)
        .then((result) => {
          if (active) {
            setEndpoints(result.endpoints);
          }
        })
        .finally(() => {
          if (active) {
            setLoading(false);
          }
        });
    };

    loadEndpoints();
    const intervalId = window.setInterval(loadEndpoints, 5000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [serviceId]);

  const filteredEndpoints = useMemo(
    () =>
      endpoints.filter((endpoint) =>
        `${endpoint.method} ${endpoint.routePath}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
      ),
    [endpoints, filter],
  );

  return (
    <Shell
      title="Endpoints"
      subtitle="Browse the routes FlowLens has observed for this service, then open one to inspect the latest and aggregated request flows."
      actions={
        <input
          className="search-input"
          placeholder="Filter endpoints"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      }
    >
      {loading ? <div className="panel">Loading endpoints…</div> : null}
      {!loading && filteredEndpoints.length === 0 ? (
        <EmptyState
          title="No endpoints observed yet"
          description="Generate traffic against the selected backend service and the endpoint map will appear here."
        />
      ) : null}

      <div className="panel table-panel">
        <table className="data-table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Storage path</th>
              <th>Writes</th>
              <th>Last status</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {filteredEndpoints.map((endpoint) => (
              <tr key={endpoint.id}>
                <td>
                  <Link to={`/endpoints/${endpoint.id}`} className="table-link">
                    <strong>{endpoint.method}</strong> {endpoint.routePath}
                  </Link>
                </td>
                <td>
                  <div className="badge-row">
                    {endpoint.hasCacheReads ? (
                      <StatusBadge tone="cache">Cache</StatusBadge>
                    ) : null}
                    {endpoint.hasDbReads ? <StatusBadge tone="db">DB</StatusBadge> : null}
                    {endpoint.hasExternalCalls ? (
                      <StatusBadge tone="external">External</StatusBadge>
                    ) : null}
                  </div>
                </td>
                <td>
                  {endpoint.hasWrites ? (
                    <StatusBadge tone="write">Writes data</StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">Read path</StatusBadge>
                  )}
                </td>
                <td>{endpoint.latestStatusCode ?? "—"}</td>
                <td>{endpoint.lastSeenAt ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
