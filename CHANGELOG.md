# Changelog

All notable changes to DeepThink are documented here. For the full release notes of each version, follow the linked file under `docs/release-notes/`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.3.0] — 2026-09-06

A **cloud-native & collaboration** release. DeepThink evolves from "single-node multi-agent orchestration + open services" (v1.2.0) to "K8s fully stateless + horizontal multi-Pod scaling + collaborative work + deeper platform capabilities".

- **Cloud-native: single-node → K8s fully stateless horizontal scaling** — the release's dominant engineering arc, closed across 5 phases: K8s cloud deployment & data persistence (Phase 1); true multi-Pod statelessness (**Redis event bus + distributed leader election + PostgreSQL sync bridge**); **Agent IPC Redis message-driven + Agent Runner as an independent Service**; Phase 3 production-grade (**pgvector** over Milvus, **MinIO/S3** object storage, **Litestream** WAL backup), followed by a full stateless-gap audit (Tier A PG data-layer: true upsert / lastInsertRowid / date(localtime); Tier B scaling: IM leader election / Claude-engine Redis IPC / periodic-task gating) and a shared concurrency counter wired to Redis so per-user/global limits hold across Pods.
- **Multi-user collaboration** — three work modes (orchestrator-worker / peer / critic-adversarial) + group-shared workspaces (`collaborations/{collabId}/` deliverables/manifest/shared-memory), all expressed as `agent + gate` graph nodes with zero intrusion into the graph-engineering core.
- **Platform capability deepening** — full-lifecycle trace (`trace_steps` atomic table + span chains + timeline API + DAG render), validate nodes & hooks (json-schema-validator + onFail fail/retry/fallback + business webhooks with HMAC/timeout/retry/idempotency), harness-eval assertions (json_schema/json_path/numeric_range/llm_judge) + eval dashboard, Skills version management (snapshot/rollback) + tools overview page. Schema 56→58; 1634 tests passing.
- **Enterprise tool governance & least-privilege baseline** — side-effect grading (read/write/admin), write idempotency keys, tool-call audit log, sliding-window rate limiting (read=120/write=30/admin=10 per 60s), AES-256-GCM credential encryption.
- **PG INTEGER→BIGINT timestamp overflow fix** + **local persistent storage stack** (`deploy/local/` docker-compose: PG+pgvector / Redis AOF / MinIO S3).
- First-level navigation simplified to 7 items; ops toolchain + one-click deploy + desktop packaging hardening.
- Image-build 403/slow-source fix, desktop packaging `tsc not found`, `_ensure-native-abi` better-sqlite3 detection, start-prod watchdog auto-restart.

📖 Full notes: [docs/release_notes/v1.3.0.md](docs/release_notes/v1.3.0.md)

## [v1.2.0] — 2026-08-28

An **orchestration & opening-up** release. DeepThink evolves from "a single autonomous Agent's vertical leap" (v1.1.0) to "multi-agent horizontal orchestration + standardized external services".

- **Multi-agent orchestration** (three orthogonal paths, all reusing the `graph-engineering` DAG engine): **Team Graph** complex task planning & execution (extended Graph DSL with `llm`/`tool`/`start`/`end`/`parallel`/`aggregate` nodes + conditional edges + fallback, Graph Planner auto-planner, node isolation / timeout / budget circuit-breaker / resume hash validation, `graph_*` WS live visualization + Gantt + replay); **Agent Workflow visual orchestration** (editable DAG canvas, per-user CRUD, team-builder draft mode, single-node Agent editing); **Orchestrator–Workers mode** (user explicitly curates reusable Workers in Agent Studio and a main Agent autonomously dispatches to them).
- **Full Autonomy Recovery Engine**: upgrades the 4 terminal hard brakes to recoverable ones (≤3 recoveries each), adds knowledge-gap self-resolution (`install_skill`/`create_skill`/`web_search`), lesson re-injection, gate auto-resume, and external-interaction archiving.
- **Agent Studio AI generate/optimize**: AI-generate a full Agent from a name/description and AI-optimize an existing Agent's prompt with diff preview; fixes the empty-canvas drag-drop bug.
- **MCP ecosystem**: **MCP Server Registry** (register any HTTP API as a standard MCP tool with param mapping / auth injection / OpenAPI import / tool test); **MCP module merge** (unified one-level menu + MCP server tool listing & test).
- **Open Platform (Agent Service)**: API Key credential system, OpenAI-style LLM MaaS (`/v1/chat/completions` + `/v1/models`), Agent as a Service (`/v1/agents/:id/chat/completions`), independent billing loop (`model_pricing` + 402 pre-check + post-hoc metering), in-console debug playground.
- **OPC one-person-company module**: company/objective CRUD + goal-driven team launch + enterprise operation dashboard.
- Security & stability fixes: SSRF CGNAT/DNS bypass, desktop dmg missing better-sqlite3 binding, npm 12 compatibility, graph terminal-state persistence, web-fetch prompt leak.

📖 Full notes: [docs/release-notes/v1.2.0.md](docs/release-notes/v1.2.0.md)

## [v1.1.0] — 2026-08-07

An **autonomy leap** release. DeepThink evolves from "tool-user-driven Loop Engineering" to a self-contained autonomous Agent system with a measurable, verifiable closed loop.

- **Autonomy Layer** — a cross-cutting layer unifying the 7 capabilities (perception / cognition / decision / execution / learning / adaptation / monitoring) with an event bus, capability registry, metrics collection (8 indicator dimensions), and a Playwright E2E acceptance suite. Schema migration 53 → 54.
- **Autonomous Mode** — a per-group continuous-push switch letting the Agent complete a task end-to-end without human hand-holding, with three defense layers (CLAUDE.md constitutional override / Supervisor clarify bypass / RLHF end-turn politeness) and four hard brakes (destructive-command detection / turn limit / token limit / loop detection).
- Desktop packaging dependency hardening.

📖 Full notes: [docs/release-notes/v1.1.0.md](docs/release-notes/v1.1.0.md)

## [v1.0.10] — 2026-07-25

An **engine expansion + execution stability + collaboration visualization** release.

- **pi engine**: the fourth Agent execution engine, integrated via long-lived stdio JSONL RPC (`pi --mode rpc`), with a rewritten protocol core (binary RPC subprocess, `PiRpcDriver`, `models.json` generation).
- **Agent Reminder mechanism**: periodically / event-driven re-injection of the task goal during long tasks to prevent context drift, surfaced in a live reminder panel.
- **Execution stability fixes**: stuck-running state, container sleep, trace not persisted.
- TeamPage execution view enhancement v2.

📖 Full notes: [docs/release-notes/v1.0.10.md](docs/release-notes/v1.0.10.md)

## [v1.0.7] — 2026-07-19

📖 Full notes: [docs/release-notes/v1.0.7.md](docs/release-notes/v1.0.7.md)

## [v1.0.5] — 2026-07-18

📖 Full notes: [docs/release-notes/v1.0.5.md](docs/release-notes/v1.0.5.md)

---

**How releases are published**: see the "Release Publishing" section of the README — tag a version (`vX.Y.Z`), the `release.yml` GitHub Action builds the three-platform desktop artifacts and publishes the GitHub Release.
