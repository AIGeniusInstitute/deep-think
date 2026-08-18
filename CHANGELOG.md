# Changelog

All notable changes to DeepThink are documented here. For the full release notes of each version, follow the linked file under `docs/release-notes/`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
