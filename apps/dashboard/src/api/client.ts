import type {
  EndpointDetail,
  EndpointGraph,
  EndpointSummary,
  FlowRunDetail,
  FlowRunSummary,
  ServiceSummary,
} from "@flowlens/shared-types";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api/v1";

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchServices(): Promise<{ services: ServiceSummary[] }> {
  return request("/services");
}

export function fetchEndpoints(
  serviceId: string,
): Promise<{ endpoints: EndpointSummary[] }> {
  return request(`/services/${serviceId}/endpoints`);
}

export function fetchEndpointDetail(endpointId: string): Promise<EndpointDetail> {
  return request(`/endpoints/${endpointId}`);
}

export function fetchEndpointGraph(
  endpointId: string,
  view: "latest" | "aggregate",
): Promise<EndpointGraph> {
  return request(`/endpoints/${endpointId}/graph?view=${view}`);
}

export function fetchEndpointRuns(
  endpointId: string,
): Promise<{ runs: FlowRunSummary[] }> {
  return request(`/endpoints/${endpointId}/runs`);
}

export function fetchFlowRunDetail(runId: string): Promise<FlowRunDetail> {
  return request(`/flow-runs/${runId}`);
}

