import { BrowserRouter, Route, Routes } from "react-router-dom";
import { EndpointDetailPage } from "../pages/endpoint-detail-page";
import { RunDetailPage } from "../pages/run-detail-page";
import { ServiceEndpointsPage } from "../pages/service-endpoints-page";
import { ServicesPage } from "../pages/services-page";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ServicesPage />} />
        <Route path="/services/:serviceId" element={<ServiceEndpointsPage />} />
        <Route path="/endpoints/:endpointId" element={<EndpointDetailPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
      </Routes>
    </BrowserRouter>
  );
}

