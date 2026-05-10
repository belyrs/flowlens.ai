# FlowLens.ai

FlowLens is a self-hosted developer understanding tool for local backend environments. This repo now contains a runnable MVP-oriented monorepo with:

- `packages/sdk`: lightweight runtime instrumentation SDK
- `apps/control-plane`: event ingest, storage, and graph projection API
- `apps/dashboard`: React UI for services, endpoints, graphs, and request runs
- `docker-compose.yml`: local orchestration for FlowLens itself

## MVP Experience

1. Start the stack with Docker Compose.
2. Start an instrumented Express backend on the same Docker network.
3. Open the dashboard.
4. Click an endpoint.
5. Inspect the node-and-arrow flow for Redis, PostgreSQL, and response behavior.

## Repo Layout

```text
apps/
  control-plane/
  dashboard/
packages/
  sdk/
  shared-types/
docs/
schemas/
docker-compose.yml
```

## Local Run

Install dependencies at the repo root:

```bash
npm install
```

Start the stack:

```bash
docker compose up --build
```

Open:

- Dashboard: [http://localhost:3000](http://localhost:3000)
- Control plane API: [http://localhost:4000/health](http://localhost:4000/health)

Connect your backend container to the same Docker network as FlowLens and point the SDK at:

```bash
FLOW_MAPPER_URL=http://flowlens-control-plane:4000/api/v1/events/batch
```

## Important Files

- [Product and architecture spec](./docs/mvp-spec.md)
- [Runtime event schema](./schemas/runtime-event.schema.json)
- [Runtime event example](./docs/runtime-event.example.json)
- [Compose blueprint reference](./docs/docker-compose.mvp.yml)

## Current Scope

Supported in the MVP:

- Node.js
- Express
- TypeORM
- PostgreSQL
- Redis
- Docker Compose

Explicitly not included:

- Kubernetes
- microservices orchestration
- distributed tracing platforms
- cloud infrastructure mapping
- AI code modification
