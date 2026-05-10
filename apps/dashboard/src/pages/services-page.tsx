import { useEffect, useState } from "react";
import type { ServiceSummary } from "@flowlens/shared-types";
import { Link } from "react-router-dom";
import { fetchServices } from "../api/client";
import { EmptyState } from "../components/empty-state";
import { Shell } from "../components/shell";
import { StatusBadge } from "../components/status-badge";

export function ServicesPage() {
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadServices = () => {
      void fetchServices()
        .then((result) => {
          if (!active) {
            return;
          }

          setServices(result.services);
          setError(null);
        })
        .catch((fetchError) => {
          if (!active) {
            return;
          }

          setError(fetchError instanceof Error ? fetchError.message : "Unknown error");
        })
        .finally(() => {
          if (active) {
            setLoading(false);
          }
        });
    };

    loadServices();
    const intervalId = window.setInterval(loadServices, 5000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <Shell
      title="Services"
      subtitle="Discover local backend services instrumented with the FlowLens SDK and jump straight into their observed endpoint flows."
    >
      {loading ? <div className="panel">Loading services…</div> : null}
      {error ? <div className="panel error-panel">{error}</div> : null}
      {!loading && services.length === 0 ? (
        <EmptyState
          title="No services discovered yet"
          description="Start an instrumented backend, make a request, and FlowLens will list the service here as soon as the SDK sends its first batch."
        />
      ) : null}

      <div className="cards-grid">
        {services.map((service) => (
          <Link
            key={service.id}
            to={`/services/${service.id}`}
            className="panel service-card"
          >
            <div className="service-card-top">
              <div>
                <p className="eyebrow">Service</p>
                <h3>{service.name}</h3>
              </div>
              <StatusBadge tone="success">{service.framework}</StatusBadge>
            </div>
            <p className="service-meta">
              {service.endpointCount} endpoint{service.endpointCount === 1 ? "" : "s"} observed
            </p>
            <p className="service-meta">
              SDK {service.sdkVersion ?? "unknown"} • last seen {service.lastSeenAt ?? "never"}
            </p>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
