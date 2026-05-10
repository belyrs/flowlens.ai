# FlowLens MVP Specification

## 1. MVP Product Specification

### Product statement

FlowLens is a self-hosted developer understanding tool for local backend environments. It helps engineering teams see how data moves through a backend request without reading the entire codebase or wiring a full observability stack.

### MVP magical experience

After starting a Docker Compose environment and adding one SDK initialization call to an Express service, a developer can click an API endpoint and immediately see a visual flow of:

- API endpoint entry
- Redis reads and writes
- PostgreSQL reads and writes through TypeORM
- Response path

### Primary user

- Backend developer working on a Dockerized Node.js application locally

### Primary user questions

- What happens when this endpoint is called?
- Does this endpoint hit Redis, PostgreSQL, or both?
- Does this endpoint write data?
- What is the likely path on a cache hit vs cache miss?
- Which major layers are involved in this request?

### Goals

- Visualize runtime request flow per endpoint
- Preserve high accuracy using observed runtime behavior
- Require minimal application changes
- Stay local-first and self-hosted
- Keep the system easy to run with Docker Compose

### Non-goals

- Production observability
- Full distributed tracing
- Generic support for every Node framework
- Source code understanding across the full codebase
- Infrastructure discovery outside the local Compose environment

### Success criteria for the MVP

- A developer can integrate the SDK into an Express app in under 15 minutes
- The dashboard lists observed endpoints after traffic is generated
- Clicking an endpoint shows latest run and aggregated graph views
- The graph correctly distinguishes cache reads, DB reads, DB writes, and response
- Sensitive headers and request bodies are not captured by default

## 2. System Architecture

### High-level architecture

```mermaid
flowchart LR
    A["Developer Calls Endpoint"] --> B["Instrumented Backend (Express + TypeORM + Redis)"]
    B --> C["FlowLens SDK"]
    C --> D["Control Plane API"]
    D --> E["Graph Projector"]
    E --> F["PostgreSQL (mapper schema)"]
    F --> G["Dashboard UI"]
    B --> H["Redis"]
    B --> I["PostgreSQL (app schema)"]
```

### Components

#### 1. Instrumented backend application

- Express API with CRUD routes
- TypeORM-backed PostgreSQL access
- Redis cache lookups and invalidations
- FlowLens SDK installed
- Serves as the proof-of-value environment for the MVP

#### 2. SDK package

- Injects request-scoped runtime context using `AsyncLocalStorage`
- Captures inbound request metadata
- Instruments TypeORM query execution
- Instruments Redis command execution
- Optionally captures outbound `fetch` calls as external request observations
- Emits redacted structured events to the control plane over HTTP

#### 3. Control plane backend

- Receives event batches from the SDK
- Stores raw runtime events for short-term debugging and replay
- Assembles request-level flow runs
- Projects runs into graph nodes and edges
- Maintains aggregated endpoint graphs and summary badges
- Serves REST APIs for the dashboard

#### 4. Dashboard UI

- Lists services and endpoints
- Shows latest request flow and aggregated endpoint graph
- Lets developers click nodes to inspect operation details
- Highlights cache vs DB paths and read vs write operations

### Design principles

- Runtime-first: prefer observed behavior over static guesses
- Accurate before easy: narrow stack support is acceptable
- Low intrusion: one SDK initialization point, minimal code changes
- Extensible graph model: new node kinds can be added without redesigning storage

### Architectural decisions

#### Single local network

All services run in one Docker Compose network. The SDK posts events to the control plane via an internal URL such as `http://control-plane:4000`.

#### Shared PostgreSQL instance, separate schemas

Use one PostgreSQL container for MVP simplicity:

- `app` schema for the instrumented backend
- `mapper` schema for FlowLens control-plane data

This reduces Compose complexity while still separating concerns.

#### Polling over websockets

The UI polls the control plane every few seconds for new runs. This keeps the MVP simpler than adding real-time subscriptions.

#### Raw events plus projected graphs

Store both:

- raw SDK events for debugging and replay
- normalized graph structures for fast UI reads

This supports accuracy, troubleshooting, and future re-projection when the graph logic evolves.

## 3. Data Model

The persistence model should be relational with graph-friendly tables and JSONB metadata.

### Core entities

#### `projects`

- `id`
- `name`
- `root_path`
- `created_at`

#### `services`

- `id`
- `project_id`
- `name`
- `runtime` (`node`)
- `framework` (`express`)
- `sdk_version`
- `first_seen_at`
- `last_seen_at`

#### `endpoints`

- `id`
- `service_id`
- `method`
- `route_path`
- `normalized_path`
- `first_seen_at`
- `last_seen_at`
- `has_cache_reads`
- `has_db_reads`
- `has_writes`
- `has_external_calls`

#### `flow_runs`

- `id`
- `service_id`
- `endpoint_id`
- `request_id`
- `status_code`
- `started_at`
- `ended_at`
- `duration_ms`
- `observation_state` (`observed`, `incomplete`)
- `redaction_level`

#### `runtime_events`

- `id`
- `service_id`
- `flow_run_id` nullable until request is complete
- `request_id`
- `event_type`
- `observed_at`
- `sequence_no`
- `payload` JSONB

#### `flow_nodes`

- `id`
- `flow_run_id` nullable for aggregated snapshots
- `endpoint_id`
- `snapshot_kind` (`latest`, `aggregate`) nullable
- `node_key`
- `node_type` (`api-endpoint`, `redis`, `postgresql`, `response`, `external-service`)
- `label`
- `operation_kind` (`read`, `write`, `request`, `response`, `call`)
- `observation_type` (`observed`, `inferred`, `unknown`)
- `confidence` numeric
- `is_write`
- `metadata` JSONB
- `sequence_index`

#### `flow_edges`

- `id`
- `flow_run_id` nullable for aggregated snapshots
- `endpoint_id`
- `snapshot_kind` (`latest`, `aggregate`) nullable
- `from_node_key`
- `to_node_key`
- `edge_type` (`request-flow`, `cache-fallback`, `response`)
- `observation_type`
- `confidence`
- `occurrence_count`
- `metadata` JSONB

#### `endpoint_snapshots`

- `id`
- `endpoint_id`
- `latest_flow_run_id`
- `graph_summary` JSONB
- `cache_strategy` (`cache-only`, `db-only`, `cache-then-db`, `mixed`, `unknown`)
- `writes_data` boolean
- `updated_at`

#### `dependencies`

- `id`
- `service_id`
- `dependency_type` (`postgresql`, `redis`, `external-http`)
- `name`
- `role`
- `metadata` JSONB

### Graph projection rules

- Each completed request becomes one `flow_run`
- Each significant observed operation becomes one `flow_node`
- Sequential relationships become `flow_edges`
- Endpoint aggregates are computed from many `flow_runs`
- Graphs expose both the latest observed run and the aggregate shape

### Observed vs inferred vs unknown

- `observed`: directly emitted by the SDK during request execution
- `inferred`: derived from repeated observed patterns or graph summarization
- `unknown`: gap or ambiguity detected, but the system cannot state the exact operation

Example:

- `Redis GET records:42` is `observed`
- `Endpoint uses cache` is `inferred`
- `Meaning of redis key records:42` is `unknown`

## 4. SDK Design

### SDK entry point

```ts
import { initializeMapper } from "backend-flow-mapper-sdk";

initializeMapper(app, {
  serviceName: "my-api-service",
  controlPlaneUrl: "http://control-plane:4000",
  dataSource,
  redisClient,
});
```

### SDK responsibilities

- Register request lifecycle middleware
- Create request context with request ID and timing
- Patch TypeORM query execution
- Patch Redis command execution
- Buffer and batch events
- Redact sensitive values before emission

### Suggested SDK options

```ts
type InitializeMapperOptions = {
  serviceName: string;
  controlPlaneUrl: string;
  dataSource: DataSource;
  redisClient?: RedisClientType;
  capturePayloads?: boolean;
  redactHeaders?: string[];
  emitIntervalMs?: number;
  sampleRate?: number;
};
```

### Integration guidance

- Call `initializeMapper` after constructing `app`, `dataSource`, and `redisClient`
- Prefer calling it before registering routes for the cleanest route metadata capture
- The SDK must still work if routes already exist by resolving route metadata at request finish time

### What the SDK captures

- request ID
- HTTP method
- matched route path
- status code
- request start and finish time
- TypeORM SQL operations
- Redis operations
- optional outbound HTTP calls through `fetch`
- parent-child linkage between request and data operations

### What the SDK does not capture by default

- Authorization headers
- Cookies
- Request body contents
- SQL parameter values
- Full Redis keys when they may contain sensitive values

## 5. Backend API Design

All APIs are local-only REST endpoints for MVP.

### Ingestion

#### `POST /api/v1/events/batch`

Receives a batch of SDK events.

Request body:

- `service`
- `sdk`
- `events[]`

Behavior:

- validate schema
- redact again on the server side
- persist raw events
- assemble `flow_run` when a request is finished
- update endpoint snapshot

### Read APIs

#### `GET /api/v1/projects`

Returns known projects.

#### `GET /api/v1/services`

Returns services with last seen status and endpoint counts.

#### `GET /api/v1/services/:serviceId/endpoints`

Returns endpoints with summary flags:

- method
- path
- last seen
- cache usage
- DB usage
- writes data
- latest status code

#### `GET /api/v1/endpoints/:endpointId`

Returns endpoint metadata and summary cards.

#### `GET /api/v1/endpoints/:endpointId/graph?view=latest`

Returns the most recent observed graph.

#### `GET /api/v1/endpoints/:endpointId/graph?view=aggregate`

Returns aggregated nodes and edges with observation counts and confidence.

#### `GET /api/v1/endpoints/:endpointId/runs`

Returns recent request runs for the endpoint.

#### `GET /api/v1/flow-runs/:runId`

Returns one detailed request flow:

- timeline
- nodes
- edges
- durations
- redaction summary

### API response shape guidance

- Use stable IDs for nodes and edges
- Return graph metadata separately from node render hints
- Include `observationType` and `confidence` on every node and edge
- Keep request payloads out unless explicitly enabled

## 6. UI Screen Breakdown

### 1. Services screen

Purpose:

- show discovered services
- show last activity
- show endpoint counts

Key UI elements:

- service cards or table
- badges for Redis, PostgreSQL, external calls
- click-through into endpoint list

### 2. Endpoint list screen

Purpose:

- browse all observed endpoints for a service

Key UI elements:

- method badge
- route path
- last seen timestamp
- cache usage badge
- DB usage badge
- writes data badge
- search and method filters

### 3. Endpoint graph screen

Purpose:

- visualize what happens when an endpoint is called

Key UI elements:

- React Flow canvas
- toggle: `Latest run` vs `Aggregate`
- node legend
- side inspector for selected node
- badges for `cache hit`, `cache miss fallback`, `writes data`

### 4. Request flow detail screen

Purpose:

- inspect one concrete request execution

Key UI elements:

- request summary
- small timeline
- ordered operation list
- graph view
- redaction note

### Graph UX rules

- Use clear node colors:
  - API Endpoint: blue
  - Redis read/write: amber
  - PostgreSQL read/write: green
  - Response: slate
- Use edge labels or badges for `read`, `write`, `fallback`, `response`
- Show observed edges as solid lines
- Show inferred edges as dashed lines
- Show unknown state as muted styling with explicit label

### Middleware handling in MVP

Middleware is useful but not required as a first-class graph node in MVP. If detected, expose it in the request detail timeline or endpoint metadata panel first. Promote it to a graph node later.

## 7. Development Milestones

### Milestone 1: Monorepo and local stack

- scaffold repo structure
- add Compose stack
- wire PostgreSQL and Redis
- start the instrumented backend and control plane shells

### Milestone 2: Control plane ingest and storage

- implement event ingestion endpoint
- persist raw events
- assemble `flow_runs`
- expose service and endpoint list APIs

### Milestone 3: SDK instrumentation

- Express request context
- TypeORM query capture
- Redis command capture
- redaction and batching

### Milestone 4: Instrumented backend

- CRUD endpoints for records
- Redis cache lookup for `GET /records/:id`
- PostgreSQL writes for create/update
- cache invalidation on writes

### Milestone 5: Graph projection and UI

- latest run graph
- aggregate graph
- endpoint list
- endpoint detail screen

### Milestone 6: Hardening

- edge-case testing
- security defaults
- sample data reset scripts
- installation guide

## 8. Security Considerations

### Default-safe capture

- redact `authorization`, `cookie`, and `set-cookie`
- do not store request bodies by default
- do not store SQL bind values
- store Redis key namespace and key hash instead of raw key when possible

### Local-first deployment

- bind services to local machine ports only
- keep all container traffic inside one Compose network
- no outbound telemetry from FlowLens itself

### Data minimization

- retain raw events for a short period, such as 7 days
- keep aggregated endpoint graphs longer than raw events
- provide a wipe/reset command for local demo environments

### Payload capture

- opt-in only
- disabled by default
- project-level or service-level setting

## 9. Explicit Out-of-Scope List

- Kubernetes
- generic distributed tracing platforms
- microservice topology management
- Java services
- Python services
- frontend runtime analysis
- cloud resource mapping
- SSH-based remote environment support
- AI-based code modification
- static code graph generation across the whole backend
- production-grade alerting, metrics, or log search
- auto-instrumentation for arbitrary ORMs or arbitrary Redis libraries

## 10. Risks and Mitigations

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| TypeORM patch misses some queries | Direct `pg` calls would not appear in the graph | Scope MVP to TypeORM-backed access only and clearly label unsupported direct driver usage |
| Async context breaks | Operations could detach from the active request | Use `AsyncLocalStorage`, test across common middleware patterns, and mark incomplete runs |
| Express route path is ambiguous | Raw URLs like `/records/42` are less useful than `/records/:id` | Resolve `req.route.path` on response finish and fall back to normalized URL patterning |
| Aggregated graphs become noisy | Conditional cache hit and miss paths can clutter the UI | Offer `Latest run` and `Aggregate` views separately and display occurrence counts |
| Redis keys leak sensitive data | Keys often include IDs or emails | Hash full keys and persist only namespace prefixes by default |
| Product drifts into observability | Scope creep slows delivery | Keep polling, local deployment, and endpoint-centric UX; do not add logs, metrics, or alerts |

## 11. Suggested Folder Structure

```text
/
├── apps/
│   ├── control-plane/
│   │   ├── src/
│   │   │   ├── api/
│   │   │   ├── ingest/
│   │   │   ├── graph/
│   │   │   ├── db/
│   │   │   └── server.ts
│   ├── dashboard/
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   ├── components/
│   │   │   ├── graphs/
│   │   │   ├── api/
│   │   │   └── main.tsx
│   └── your-express-app/
│       └── FlowLens SDK integration point
├── packages/
│   ├── sdk/
│   │   ├── src/
│   │   │   ├── express/
│   │   │   ├── redis/
│   │   │   ├── typeorm/
│   │   │   ├── emitter/
│   │   │   └── index.ts
│   └── shared-types/
│       └── src/
├── docs/
│   ├── mvp-spec.md
│   ├── docker-compose.mvp.yml
│   └── runtime-event.example.json
├── schemas/
│   └── runtime-event.schema.json
└── package.json
```

### Why this structure

- `apps` keeps deployable services separate
- `packages/sdk` isolates the installable npm package
- `packages/shared-types` avoids event schema drift between SDK, backend, and UI
- `docs` and `schemas` keep product and contract documentation close to code

## 12. First Implementation Plan

### Phase 1: prove the magical path

Build only enough to demonstrate:

- `GET /records/:id`
- `POST /records`
- Redis lookup
- PostgreSQL fallback or write
- endpoint graph in the UI

This should be the first proof-of-value flow.

### Phase 2: tighten correctness

- normalize route matching
- classify SQL and Redis reads vs writes
- add aggregate graph generation
- show cache and DB badges in endpoint list

### Phase 3: operational polish

- redaction configuration
- endpoint filters
- run history
- reset seed scripts
- documentation

### Suggested implementation order

1. Scaffold monorepo and Docker Compose
2. Connect one Express backend with visible cache and DB paths
3. Build SDK request context and event batching
4. Build control plane ingestion and graph persistence
5. Build endpoint list and latest run graph UI
6. Add aggregate graph and security polish

## 13. Docker Compose Setup

See [docker-compose blueprint](./docker-compose.mvp.yml).

During Milestone 1, this blueprint should be promoted to the repo root as `docker-compose.yml`.

### MVP services

- `postgres`
- `redis`
- `control-plane`
- `dashboard`
- `instrumented-backend`

### Suggested default ports

- dashboard: `3000`
- instrumented backend: `5106`
- control plane: `4000`
- postgres: `5432`
- redis: `6379`

### Environment model

- `DATABASE_URL=postgres://postgres:postgres@postgres:5432/flowlens`
- `APP_DB_SCHEMA=app`
- `MAPPER_DB_SCHEMA=mapper`
- `REDIS_URL=redis://redis:6379`
- `FLOW_MAPPER_URL=http://control-plane:4000`

## 14. SDK Instrumentation Approach

### Express instrumentation

- Register a top-level middleware
- Start `AsyncLocalStorage` context per request
- Attach generated request ID
- Capture request start time
- On `res.finish`, emit request completion event with route path and status code

### TypeORM instrumentation

Instrument at the query execution layer rather than entity subscriber level.

Recommended MVP approach:

- patch `QueryRunner.query`
- normalize SQL text
- classify operation type:
  - `SELECT` -> read
  - `INSERT`, `UPDATE`, `DELETE` -> write
- extract table names heuristically
- emit one event per executed query

Why this approach:

- catches query builder operations
- catches repository operations
- provides the closest runtime truth for DB access

### Redis instrumentation

Recommended MVP approach:

- patch the Node Redis client command path
- classify commands:
  - `GET`, `MGET`, `HGET`, `EXISTS` -> read
  - `SET`, `DEL`, `HSET`, `INCR`, `EXPIRE` -> write
- record command, key namespace, and redacted key reference

### External HTTP instrumentation

Best-effort only for MVP:

- patch global `fetch`
- record method, host, path template, and status code
- expose in request detail view first

This should not block MVP completion.

### Event batching

- collect events in memory per service instance
- flush every `N` events or every `T` milliseconds
- flush request completion events immediately if possible
- tolerate control-plane unavailability without crashing the host app

### Failure behavior

- SDK must never break business logic
- if emission fails, drop or retry in the background
- never block response completion on telemetry delivery

## 15. Sample Runtime Event Schema

See [runtime event schema](../schemas/runtime-event.schema.json).

For a concrete payload example, see [runtime event example](./runtime-event.example.json).

### Example flow for `GET /records/:id`

1. `request.started`
2. `redis.command` with `GET`
3. optional `db.query` with `SELECT`
4. `request.finished`

### Example flow for `POST /records`

1. `request.started`
2. `db.query` with `INSERT`
3. optional `redis.command` with `DEL` or `SET`
4. `request.finished`

## Recommendation

For the first working release, optimize for one clearly visible graph:

`GET /records/:id`

If that endpoint can reliably show:

- request entry
- cache lookup
- DB fallback on miss
- response return

then the product already demonstrates its core value.
