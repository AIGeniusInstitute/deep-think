**Languages**: [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [हिन्दी](README.hi.md) · [العربية](README.ar.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [मराठी](README.mr.md) · [తెలుగు](README.te.md) · [Türkçe](README.tr.md) · [தமிழ்](README.ta.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Nederlands](README.nl.md) · [ไทย](README.th.md) · [ગુજરાતી](README.gu.md) · [Bahasa Melayu](README.ms.md) · [ಕನ್ನಡ](README.kn.md) · [فارسی](README.fa.md) · [Svenska](README.sv.md) · [Čeština](README.cs.md)

<p align="center">
  <img src="static/deep-think-logo.png" alt="DeepThink Logo" width="400" />
</p>

<h1 align="center">DeepThink</h1>

<p align="center">
  A self-hosted, multi-user local AI Agent Loop Engineering system (desktop + browser + mobile) / Powered By AI Genius Institute，AI光剑.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/AIGeniusInstitute/deepthink/stargazers"><img src="https://img.shields.io/github/stars/AIGeniusInstitute/deep-think?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

<p align="center">
  <a href="#what-is-deepthink">Introduction</a> · <a href="#core-capabilities">Core Capabilities</a> · <a href="#quick-start">Quick Start</a> · <a href="#technical-architecture">Technical Architecture</a> · <a href="#contributions">Contributions</a>
</p>

---

<p align="center">
  <img src="static/deepthink-v1.0.6.gif" alt="DeepThink Intro" width="800" />
</p>


## What is DeepThink

DeepThink, an Open Source Enterprise-grade Autonomous Agent self-evolving superintelligence platform, is a pioneer in the transition from Harness Engineering to the Loop Engineering paradigm and a new generation of AI Infrastructure (AI Infra) for enterprise customers. The DeepThink platform centers on a multi-Agent collaboration framework, fusing AI Coding, Self-Evolving, Full-Stack Observability, Bug Auto-Fix Loop, and Human-Agent Symbiosis to build an enterprise-grade AI system that continuously learns, self-improves, and ultimately grows into a superintelligence:

- **AI Autonomous R&D Platform** — Agents independently complete the full software development lifecycle, eliminating the need for human engineers on routine coding tasks
- **Self-Evolving Agent Engine** — Agents continuously learn from errors, absorb knowledge from the codebase, and evolve from user feedback
- **Programmer-Agent Collaboration Hub** — Every programmer owns a personal "Development Project" containing multiple parallel sessions, with a central scheduler preventing concurrency conflicts
- **Enterprise SaaS Platform** — Multi-tenant isolation, tiered permissions, elastic billing, and enterprise integrations (Feishu/DingTalk/WeCom/LDAP)
- **Superintelligence Incubator** — Through continuous evolution, a single Agent ultimately attains the comprehensive capabilities of a full software team

> "Let every enterprise own a never-stopping, continuously evolving AI super R&D team — from tool user, to code creator, ultimately growing into a self-replicating superintelligence. Let us walk together on the road to AGI."

### Key Features

- **Native Claude Code Powered** — Built on the Claude Agent SDK, with the full Claude Code CLI runtime underneath, inheriting all of its capabilities
- **Harness & Loop Engineering** — Versioned harness manifests (system prompt / subagents / tools / skills) with snapshot / diff / eval / promote / rollback, plus long-running autonomous task loops with per-iteration review and failure re-injection
- **Autonomy Layer & Autonomous Mode** *(v1.1.0)* — A cross-cutting Autonomy Layer unifies the 7 capabilities (perception / cognition / decision / execution / learning / adaptation / monitoring) with metrics collection + E2E acceptance; plus a full Autonomous Mode that lets the Agent complete a task end-to-end without human hand-holding, covering three defense layers (CLAUDE.md constitutional override / Supervisor clarify bypass / RLHF end-turn politeness) and four hard brakes (destructive commands / turn limit / token limit / loop detection)
- **Agent-as-a-Service (PaaS)** — Create, version, mount, share, and install DB-backed Agent definitions across tenants, with per-user quotas, admin review, and a publishable template marketplace
- **Multi-User Isolation** — Per-user workspaces, per-user IM channels, an RBAC permission system, invite-code registration, and audit logs; every user has an independent execution environment
- **Eight-Channel Unified Routing** — Feishu (streaming cards + Reactions), Telegram Bot API, QQ Bot API v2, DingTalk Stream, WeChat iLink, Discord Gateway, WhatsApp (Baileys), and the Web interface — all routed uniformly
- **Multi-Engine & Multi-Provider** — Pluggable code-agent engines (Claude Code / AtomCode / Codex / OpenCode) and multiple Claude API providers with three load-balancing strategies (round-robin / weighted / failover), automatic health detection and recovery
- **Sandboxed Code Execution** — Docker + seccomp + cgroups hardened sandbox for Python / Node / shell code execution and Chromium CDP browser automation, exposed to the Agent as MCP tools
- **Billing & Usage Statistics** — A complete billing system (subscription plans, wallet balance, redemption codes), per-model token usage tracking, and chart visualizations
- **Mobile PWA** — Deeply optimized for mobile, supports one-tap install to the home screen, fully adapted for iOS / Android
- **Internationalized** — 29 UI languages with native endonyms and RTL support; the Agent replies in the user's chosen language

> The project draws on the containerized architecture of [OpenClaw](https://github.com/nicepkg/OpenClaw) and incorporates the multi-session collaboration ideas from Claude Code's official [Cowork](https://github.com/anthropics/claude-code/tree/main/packages/cowork): multiple independent Agent sessions work in parallel, each with its own isolated workspace and persistent memory, and results are delivered via IM channels.

## Feature Showcase

A visual walkthrough of DeepThink's core capabilities — what each screen looks like and the value it delivers to the user.

| Screenshot | Feature | Core Highlights | What it means for you |
|------|------|------|------|
| <img src="static/deep-think-main-workspace.png" width="280" /> | **Main Workspace** | Multi-conversation tabs, streaming Markdown, real-time thinking panel, tool-call tracing | One workspace holds many parallel chats — switch context without losing state, watch the Agent think and act live |
| <img src="static/deep-think-agent-studio.png" width="280" /> | **Agent Studio** | Create / version / mount custom Agent definitions, host-capability preflight, snapshot management | Define your own specialist Agents (code-reviewer, web-researcher, …) and reuse them across every session |
| <img src="static/deep-think-agent-edit.png" width="280" /> | **Agent Editor** | Edit `~/.claude/agents/*.md` from the Web UI, system-prompt + tools + subagents in one form | Tune an Agent's behavior in plain language — no file digging, changes apply on the next session |
| <img src="static/deep-think-agent-test.png" width="280" /> | **Agent Test** | Run an Agent against sample inputs before publishing, inspect the full output trace | Ship Agents with confidence — verify behavior on test cases before letting them loose in production |
| <img src="static/deep-think-multi-engine.png" width="280" /> | **Multi-Engine** | Pluggable engines (Claude Code / AtomCode / Codex / OpenCode), unified availability dashboard | Pick the best brain for each task — switch engines per session without re-architecting the platform |
| <img src="static/deep-think-engine-config.png" width="280" /> | **Engine Config** | Per-engine daemon lifecycle, provider credentials, health status at a glance | Run multiple providers side by side — add credentials, monitor liveness, and fail over automatically |
| <img src="static/deep-think-atomcode-engine.png" width="280" /> | **AtomCode Engine** | Standalone HTTP/SSE daemon, per-agent-runner loopback port, auto-teardown | Use AtomCode as an alternative coding engine — isolated daemon per process, no port conflicts |
| <img src="static/deep-think-marketplace.png" width="280" /> | **Marketplace** | Admin-publishable templates (agent / mcp / skill / kb), browse, rate, one-click install | Discover and install shared Agents and tools like an app store — admins curate, users install in one click |
| <img src="static/deep-think-mcp-servers.png" width="280" /> | **MCP Servers** | Per-workspace stdio + HTTP MCP Servers, independent of global config | Give each workspace its own toolset — connect Notion, GitHub, databases… scoped exactly to that project |
| <img src="static/deep-think-skills.png" width="280" /> | **Skills** | Project / user / workspace-level Skills, auto-discovered via volume mounts + symlinks | Teach the Agent new tricks per project — no image rebuild, skills appear in the next session |
| <img src="static/deep-think-memory.png" width="280" /> | **Memory System** | User-global / session / date memory, full-text search, online editing | The Agent remembers you across sessions — recall preferences, project context, and decisions without re-explaining |
| <img src="static/deep-think-cron-task.png" width="280" /> | **Scheduled Tasks** | Cron / interval / one-time, Agent or Script execution, group or isolated context, IM notification on completion | Automate recurring work — nightly reports, periodic checks, self-running loops that ping you on Feishu/Telegram when done |
| <img src="static/deep-think-sandbox.png" width="280" /> | **Sandboxed Execution** | Docker + seccomp + cgroups, Python / Node / shell code, Chromium CDP browser automation | Let the Agent run untrusted code and drive a browser safely — hardened isolation, exposed as MCP tools |
| <img src="static/deep-think-system-monitor.png" width="280" /> | **System Monitor** | Container list, queue state, per-provider active sessions, health checks, one-click image build | See exactly what's running — spot stuck containers, balance load, and rebuild images from the browser |
| <img src="static/deep-think-tokens.png" width="280" /> | **Usage & Billing** | Per-model token breakdown (input / output / cache), USD cost, bar + pie charts, multi-dimensional filters | Know where your tokens and money go — slice by user, model, and time range, bill teams accurately |
| <img src="static/deep-think-about.png" width="280" /> | **About** | Version, build info, project links, one-click update checks | Stay current — see your build version and jump straight to docs, repo, and update channels |

## Core Capabilities

### Multi-Channel Access

| Channel | Connection | Message Format | Highlights |
|------|---------|---------|------|
| **Feishu** | WebSocket long connection | Streaming cards (typewriter effect) | Native streaming render, multi-card auto-split, image/file downloads to workspace, Reaction feedback, group @mention control |
| **Telegram** | Bot API (Long Polling) | Markdown → HTML | Long-message auto-chunking (3800 chars), images via Vision (base64), document files auto-downloaded to workspace |
| **QQ** | WebSocket (Bot API v2) | Streaming cards / plain text | DM + group @Bot, streaming typewriter (`stream_messages`), image messages (Vision), pairing-code binding |
| **DingTalk** | Stream protocol long connection | Markdown cards | AI Card streaming typewriter, message deduplication (LRU 1000 / 30min TTL), image downloads (downloadCode / contentUrl), group @mention filtering |
| **WeChat** | iLink Bot API (Long Polling) | Plain text (2000 chars) | QR-code scan pairing, CDN image download + AES decryption, typing indicator, auto-reconnect |
| **Discord** | discord.js Gateway (WebSocket) | Streaming-edit messages | Guild / DM, attachment handling, 2000-char auto-split, ack Reaction, 500ms throttled streaming-edit replies |
| **WhatsApp** | Baileys (WhatsApp Web protocol) | Markdown → plain text | QR / pairing-code login, multi-file auth state, media (image/video/audio/document) downloads, group participant events |
| **Web** | WebSocket real-time | Streaming Markdown | Image paste/drag-upload, virtual scrolling, Mermaid chart rendering, image lightbox |

Each user can independently configure their own IM channels (Feishu app credentials, Telegram Bot Token, QQ Bot credentials, DingTalk Client ID/Secret, WeChat iLink Token, Discord Bot Token, WhatsApp QR) without interfering with each other. Messages are uniformly routed: messages from each channel reply to that channel, and messages from the Web reply on the Web.


### Multi-Engine & Multi-Provider

DeepThink supports pluggable code-agent engines and multiple API providers for high-availability deployment:

- **Pluggable engines** — Select per session between Claude Code, AtomCode, Codex, and OpenCode; the Engines page shows a unified availability dashboard and manages each engine's daemon lifecycle
- **Three load-balancing strategies** — Round-Robin, Weighted, Failover
- **Automatic health detection** — Consecutive error tracking (3 errors by default marks unhealthy), 5-minute auto-recovery probing
- **Per-group provider switching** — The monitoring page lets you specify which provider each workspace uses
- **OAuth credential support** — Supports Claude Code OAuth Tokens, compatible with all authentication methods; sticky provider selection avoids cross-OAuth thinking-block signature failures
- **Active session counts** — Real-time display of concurrent usage per provider


### Agent Execution Engine

Built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript); the SDK invokes the full Claude Code CLI underneath.

- **Per-user primary workspace** — Each user has a fixed primary workspace (admin uses host mode, member uses container mode); IM messages are routed to their respective primary workspaces
- **Host mode** — Agent runs directly on the host, accessing the local filesystem with zero Docker dependency (default mode for the admin primary workspace)
- **Container mode** — Docker-isolated execution, non-root user, 40+ preinstalled tools (default mode for the member primary workspace)
- **Multi-session concurrency** — Up to 20 containers + 5 host processes running simultaneously, session-level queue scheduling
- **Script tasks** — Scheduled tasks support both Agent and Script execution types; Script mode directly executes shell commands
- **Custom working directory** — Each session can configure `customCwd` to point to a different project
- **Automatic failure recovery** — Exponential-backoff retry (5s → 80s, up to 5 attempts); context-overflow auto-compression with history archiving
### Harness Engineering

Administrators can snapshot, diff, eval, promote, and roll back the model's **harness** — the full set of system prompt, subagents, tools, and skills — as versioned manifests. Each harness version can be behavior-evaluated with evidence-based judging before promotion, so you can safely evolve an Agent's configuration and instantly roll back a regression.

### Loop Engineering

Long-running autonomous task loops that keep working after you walk away. Six loop modes are supported — `goal`, `loop`, `schedule`, `proactive`, `adaptive`, and `skill_evolution`. Each iteration is reviewed by the SDK and failure reasons are re-injected into the next iteration, closing the self-improvement loop. Loops are driven by slash commands and surface live `loop_start` / `loop_iteration_start` / `loop_iteration_end` / `loop_goal_check` / `loop_review_result` / `loop_end` stream events.


### Autonomy Layer & Autonomous Mode *(v1.1.0)*

A two-piece upgrade that takes DeepThink from "tool-user-driven Loop Engineering" to "fully self-contained autonomous Agent system."

**Autonomy Layer** — A cross-cutting layer that unifies the 7 capabilities (perception / cognition / decision / execution / learning / adaptation / monitoring) into a measurable, verifiable, closed-loop system. Built on top of the existing self-evolving / loop / supervisor / super-agent / graph modules, it adds an event bus, capability registry, metrics collection (8 indicator dimensions), and a Playwright E2E acceptance suite.

- **Capability registry** — `GET /api/autonomy/capabilities` returns the 7 canonical capabilities in canonical order
- **Metrics collection** — Per-capability indicators (proactivity_ratio / decision_independence / execution success / learning latency / adaptation_speed / prediction accuracy / self-heal rate) flow through an event bus into the metrics table, aggregated via `aggregateMetric`, exposed at `GET /api/autonomy/metrics`
- **Signal → adaptation loop** — `POST /api/autonomy/signals` + `POST /api/autonomy/signals/process` drives signals through to applied adaptations, with `adaptation_speed_ms` collected
- **Learning loop** — `graph_run` results sediment into lessons; `GET /api/autonomy/lessons` retrieves them for re-injection
- **Self-heal & prediction** — Consecutive errors trigger `monitoring.predicted` + `self_healed` events; the dashboard surfaces health, signals, and lessons
- **Schema migration** — SCHEMA_VERSION 53 → 54 (4 tables, idempotent `IF NOT EXISTS`)

> The 7-capability collection closed-loop is fully wired (signal → event → metrics table → aggregateMetric → API → E2E assertion). Reaching the headline targets (≥95% proactivity, ≥90% success, etc.) depends on accumulating real-world traffic — the skeleton is ready, the bar is quantified.

**Autonomous Mode** — A per-group continuous-push switch: once the Agent enters a task, it completes it end-to-end with no human hand-holding. Three defense layers cover the natural friction points, and four hard brakes keep autonomy safe.

- **Defense layer 1 — CLAUDE.md constitutional override** — Injects an `Autonomous Override` section into the agent-runner with 6 rules: no asking the user, disable `AskUserQuestion`, fill in `<assumption>`, loop detection, hard brakes, and what to do when the task cannot be completed
- **Defense layer 2 — Supervisor clarify bypass** — `supervisor.ts parseDecision` downgrades `clarify` → `delegate` when autonomous is on, drops the question (`reason='autonomous_downgrade'`); any explicit `instruction` is preserved
- **Defense layer 3 — RLHF end-turn politeness** — The agent-runner main loop detects end-turn asking behavior (strong signal: `AskUserQuestion` tool call; weak signal: `ASKING_PATTERNS`) and auto-continues without breaking
- **Hard brake 1 — Destructive-command detection** — 14 positive patterns (`rm -rf /`, `git push --force`, `git reset --hard`, `DROP TABLE/DATABASE`, `TRUNCATE`, `DELETE FROM` without `WHERE`, `mkfs.*`, `dd to /dev/`, fork bomb, …) with 10 negative patterns to avoid false positives (`rm -rf ./build`, `git push --force-with-lease`, guarded `DELETE … WHERE`)
- **Hard brake 2 — Turn limit** — Forced stop after max turns
- **Hard brake 3 — Token limit** — Forced stop after token budget
- **Hard brake 4 — Loop detection** — Sliding window of the last 3 identical turns (hash of first 5000 chars, deterministic) triggers an abort
- **Per-group config + per-message override** (`true` / `false` / `null`); `messages.autonomous` and `scheduled_tasks.autonomous` columns persist the flag
- **APIs** — `GET / PUT /api/config/autonomous`, `GET /api/config/autonomous/all`
- **UI** — `AutonomousToggle` switch, `AutonomousStopButton` hard-brake button, `CreateTaskForm` checkbox, 4 new StreamEvents (`autonomous_started` / `autonomous_continued` / `autonomous_aborted` / `autonomous_brake`), persistent banner + rocket-emoji badge so the "Agent is fully self-driving" state stays visible throughout long tasks

> Verified: Autonomy 31 unit tests + 18 E2E, Autonomous Mode 49 unit tests + 20 E2E (14 mode + 6 brake), zero new regressions across the 1325-test baseline. See `docs/test_report/autonomy-system/REPORT.md` and `docs/test_report/feat-autonomous-mode/TEST_REPORT.md`.


### Agent-as-a-Service (PaaS)

A multi-tenant platform for turning Agents into shareable, installable products:

- **DB-backed Agent definitions** — Create and version Agent definitions with snapshots, mounts, collaborators, and shares
- **Admin review workflow** — Per-user quotas and admin approval before publishing
- **Install & mount** — Install a shared Agent into your own workspace; mount it into a session on demand
- **Marketplace** — Admin-publishable template marketplace (agent / mcp / skill / kb templates) with browse, rate / review, report, and one-click install, plus idempotent startup seeding


### Knowledge Bases

Per-user knowledge bases that ground the Agent in your own documents:

- **FTS5 full-text search** — Built-in SQLite FTS5 indexing across mounted documents
- **Vector embeddings** — Optional OpenAI-compatible embedding endpoint for semantic retrieval
- **Document extraction** — Plain-text extraction from PDF / DOCX / MD / etc. for indexing, plus LibreOffice → PDF preview for Office documents
- **`kb_search` MCP tool** — Agents query mounted KBs directly at runtime


### Sandboxed Code Execution

A hardened sandbox for running untrusted code and driving a browser, exposed to the Agent as MCP tools:

- **Docker + seccomp + cgroups** — Hardened isolation with a seccomp profile and resource limits
- **Code execution** — `sandbox_run_code` / `sandbox_close` for Python, Node, and shell, in session or single-exec mode
- **Browser automation** — `sandbox_browser_navigate` / `_click` / `_type` / `_screenshot` / `_evaluate` driving a Chromium CDP target via the in-sandbox forwarder


### Claude Code Plugins

First-class support for Claude Code Plugins:

- **Per-user enable/disable** — Each user opts into plugins independently; changes take effect on the next new session (the UI prompts accordingly)
- **Immutable content-hashed catalog** — Admin scans the host once to build a shared catalog; plugin snapshots are content-addressed and immutable
- **Dependency preflight** — Best-effort check of `commands/*.md` `allowed-tools` and hook commands before materialization, with a manual override table
- **Runtime materialization** — Per-user enabled refs are materialized into versioned `--plugin-dir` paths at spawn time


### Agent Studio & Agent Definitions

A dual layer for defining custom Agents:

- **Global agents** — Edit `~/.claude/agents/*.md` directly from the Web UI
- **DB-backed user Agents** — Versioned snapshots, workspace mounts, collaborators, and share links
- **Host-capability preflight** — Validates that the host has the required tools before an Agent runs


### Chat Trace

A DAG visualization of Agent execution — every node (turn / tool / review / goal_check / skill / subagent) is rendered as a navigable graph with user annotations and client-side rerun / continue-from-here, giving full-stack observability into how an Agent reached its answer.


### Supervisor & i18n

- **Supervisor SubAgent** — An opt-in per-chat intent parser that pre-triages incoming messages (`clarify` / `delegate` / `auto`) before the main Agent runs, reducing wasted work on ambiguous requests
- **Internationalization** — 29 UI languages with native endonyms and RTL flags; the chosen language is injected into Agent prompts so replies match the user's language
### Multi-Conversation & Agent Definitions

Multiple independent conversations are supported within the same workspace, each with its own context and session:

- **Conversation tabs** — Draggable tab bar; supports creating, renaming, and deleting conversations
- **Per-conversation IM binding** — Each conversation can independently bind to an IM channel
- **Custom Agent definitions** — Create custom SubAgents (e.g., code-reviewer, web-researcher), reusing the Claude Agent SDK's `agents` option
- **Independent session persistence** — Each conversation maintains its own Claude session, fully isolated


### Real-Time Streaming Experience

The Agent's thinking and execution process is pushed to the frontend in real time across **30+ stream-event types** (text, thinking, tool use, hooks, tasks, memory recall, loops, usage, todo, context audit, and more):

- **Thinking process** — Collapsible Extended Thinking panel, streamed character by character
- **Tool-call tracing** — Tool name, execution duration, nesting depth, input-parameter summary
- **Call-trail timeline** — The last tool-call records for quick backtracking
- **Hook execution status** — PreToolUse / PostToolUse Hook start, progress, and result
- **Loop events** — Live `loop_iteration_*` and `loop_review_result` events for autonomous loops
- **Streaming Markdown rendering** — GFM tables, code highlighting, Mermaid charts, image lightbox
- **Share as image** — Export messages as shareable images
- **Feishu streaming cards** — Native typewriter effect, three-tier fallback chain (Streaming → CardKit v1 → Legacy), multi-card auto-split, 100K-char single-element support
- **DingTalk / QQ / Discord streaming** — Native streaming-card / streaming-edit typewriter effects per channel


### Billing System

<details>
<summary>Complete subscription and usage billing system (click to expand)</summary>
<br/>

A billing system designed for multi-user deployment, supporting flexible billing modes:

- **Subscription plan management** — Admins create billing plans, setting price, token quota, and validity period
- **User wallet** — Each user has an independent balance, supporting top-ups and consumption
- **Redemption code system** — Create redemption codes with maximum usage counts and expiration times
- **Per-model token tracking** — Token usage records precise to the model level (input/output/cache)
- **Cost calculation** — Automatically calculates cost in USD based on model pricing
- **Admin console** — Plan CRUD, user-balance management, redemption-code management, billing audit logs
- **Quota checks** — Automatically checks user quota and balance before requests; blocks execution when exceeded

</details>


### Usage Statistics

- **Token usage breakdown** — Input tokens, output tokens, cache read/create tokens, each tracked independently
- **Cost calculation** — Automatically calculates cost per model, with USD formatting
- **Multi-dimensional filtering** — Filter flexibly by user, model, and time range (7/14/30/90 days)
- **Chart visualization** — Bar charts and pie charts showing usage trends and distribution
- **Admin view** — Admins can view usage data for all users


### 27 MCP Tools

At runtime the Agent can communicate with the main process via the built-in MCP Server (22 unconditional + 5 conditional):

| Tool | Description |
|------|------|
| `send_message` / `send_image` / `send_file` | Send a message, image, or file to a user/group immediately while running |
| `schedule_task` / `list_tasks` / `update_task` | Create scheduled/recurring/one-time tasks (cron / interval / once); list and update them |
| `pause_task` / `resume_task` / `cancel_task` | Pause, resume, cancel tasks |
| `register_group` | Register a new group (admin primary workspace only) |
| `install_skill` / `uninstall_skill` / `create_skill` | Install, uninstall, or create a Skill (primary workspace only) |
| `memory_append` / `memory_search` / `memory_get` | Append, full-text-search, and read workspace memory files |
| `kb_search` | Search mounted knowledge bases (FTS5 + optional vector embeddings) |
| `sandbox_run_code` / `sandbox_close` | Run Python / Node / shell code in the hardened sandbox; close a sandbox session |
| `sandbox_browser_navigate` / `_click` / `_type` / `_screenshot` / `_evaluate` | Drive a Chromium CDP browser inside the sandbox |
| `discord_get_server_info` / `discord_get_channel_info` / `discord_get_history` | Read Discord server / channel metadata and message history |


### Scheduled Tasks

- **Three scheduling modes** — Cron expressions / fixed interval / one-time execution
- **Two execution types** — Agent (launches a full Claude Agent) / Script (directly executes shell commands)
- **Two context modes** — `group` (executes in a specified session) / `isolated` (independent isolated environment)
- **Notification channels** — On task completion, notify a specified IM channel (Feishu / Telegram / QQ / DingTalk / WeChat / Discord)
- **Full execution logs** — Duration, status, result, all managed via the Web interface


### Memory System

The Agent autonomously maintains persistent cross-session memory:

- **User global memory** — `data/groups/user-global/{userId}/CLAUDE.md`; each user has an independent global memory, readable by all sessions
- **Session memory** — `data/groups/{folder}/CLAUDE.md`, private to the session
- **Date memory** — `memory/YYYY-MM-DD.md`, for time-sensitive information
- **Conversation archive** — PreCompact Hook automatically archives to `conversations/` before context compression
- **Full-text search** — Online editing + search from the Web interface
### Workspace-Level Configuration

Each workspace can independently configure its own runtime environment:

- **Per-workspace MCP Servers** — Add stdio or HTTP MCP Servers to a workspace, independent of the global config
- **Per-workspace Skills** — Install specific Skills for a workspace, enabled on demand
- **Per-workspace environment variables** — Group-level environment-variable overrides, higher priority than global config
- **Shared workspace members** — Multiple users can join the same workspace to collaborate
- **Cross-group ACL** — A pure authorization function governs inter-group IPC routing (folder / user / bound-IM rules) so non-home Agents can safely message bound channels


### IM Binding System

A flexible mechanism for binding IM channels to workspaces:

- **Workspace-level binding** — Bind an IM group/DM to a specified workspace or specific conversation
- **Feishu topic-group mapping** — After binding a Feishu topic group, each topic is automatically mapped to an independent session with its own context; the workspace switches to a vertical topic-list navigation
- **Slash-command management** — `/bind <target>` to bind, `/unbind` to unbind, `/where` to view the current binding, `/new <name>` to create a new workspace and bind
- **Web settings management** — View and manage all IM bindings from the settings page


### Skills System

- **Project-level Skills** — Placed in `container/skills/`, auto-mounted on all containers
- **User-level Skills** — Placed in `~/.claude/skills/`, auto-mounted on all containers
- **Workspace-level Skills** — Install Skills for a specific workspace via the Web interface
- No image rebuild needed; volume mounts + symlinks enable auto-discovery

### Web Terminal

A complete terminal based on xterm.js + node-pty: WebSocket connection, draggable resizable panel, operate containers directly from the Web interface.


### Docker Build UI

Build Docker images with one click from the Web monitoring page; build logs are streamed in real time via WebSocket — no need to run commands in a terminal manually.


### Mobile PWA

A Progressive Web App optimized for mobile, installable to the home screen from a mobile browser in one tap:

- **Native experience** — Full-screen mode, standalone app icon, visually indistinguishable from a native app
- **Responsive layout** — Mobile-first design; chat interface, settings pages, and monitoring panels all adapt to small screens
- **iOS / Android adaptation** — Safe-area handling, scroll optimization, font rendering, touch interaction
- **Always available** — Anytime, anywhere; pull out your phone to chat with the AI Agent, check execution status, and manage tasks


### File Management

- **Full file browser** — Tree-view directory structure, file-type icons
- **File operations** — Upload (50MB limit, drag-and-drop supported) / download / delete / create directory
- **File preview** — Online text-file viewing, image preview + lightbox, Markdown rendering, Office-document → PDF preview
- **Security** — Path-traversal protection + system-path protection

### Security & Multi-User

| Capability | Description |
|------|------|
| **User isolation** | Each user has an independent primary workspace (`home-{userId}`), working directory, and IM channel |
| **Personalization** | Users can customize AI name, avatar emoji / color / uploaded image |
| **RBAC** | 5 permissions, 4 role templates (admin_full / member_basic / ops_manager / user_admin) |
| **Registration control** | Open registration / invite-code registration / closed registration |
| **Audit logs** | 18 event types, full operation tracking |
| **Encrypted storage** | API keys encrypted with AES-256-GCM; Web API returns only masked values |
| **Mount security** | Whitelist validation + blacklist pattern matching (`.ssh`, `.gnupg`, and other sensitive paths) |
| **Terminal permissions** | Users can access the Web terminal of their own container (not supported in host mode) |
| **Login protection** | 5 failures lock for 15 minutes, bcrypt 12 rounds, HMAC Cookie, 30-day session validity |
| **Session management** | View and delete active login sessions; supports multi-device management |
| **CORS / WS defense** | Configurable allowed origins; WebSocket upgrade rejects non-allowlisted origins with 403 (CSWSH defense) |
| **PWA** | One-tap install to the phone home screen, deeply optimized for mobile, use the AI Agent anytime, anywhere |
## Quick Start

### Prerequisites

Before you begin, ensure the following dependencies are installed:

**Required**

- **[Node.js](https://nodejs.org) >= 20** — Runs the main service and frontend build
  - macOS: `brew install node`
  - Linux: See [NodeSource](https://github.com/nodesource/distributions) or use `nvm`
  - Windows: [Download from the official site](https://nodejs.org)

- **[Docker](https://www.docker.com/)** — Runs Agents in container mode and the code-execution sandbox (required for member users; admin host-only mode can skip this)
  - macOS: [OrbStack](https://orbstack.dev) recommended (lighter), or [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  - Linux: `curl -fsSL https://get.docker.com | sh`
  - Windows: [Docker Desktop](https://www.docker.com/products/docker-desktop/)

- **Claude API Key** — Official Anthropic or compatible relay services (various Coding Plans); configure it in the Web interface after launch

**Optional** (only if you want the corresponding IM channel)

- Feishu enterprise self-built app credentials — create at the [Feishu Open Platform](https://open.feishu.cn)
- Telegram Bot Token — obtain via [@BotFather](https://t.me/BotFather)
- QQ Bot credentials — create at the [QQ Open Platform](https://q.qq.com/qqbot/openclaw/index.html)
- DingTalk Bot credentials — create at the [DingTalk Open Platform](https://open.dingtalk.com)
- WeChat iLink Bot Token
- Discord Bot Token — create at the [Discord Developer Portal](https://discord.com/developers/applications)
- WhatsApp account — scan a QR code on first launch (Baileys protocol)

> The Claude Code CLI does not need to be installed manually — the Claude Agent SDK bundled as a project dependency already includes the full CLI runtime, and it is installed automatically on the first `make start`.

### Installation & Launch

```bash
# 1. Clone the repository
git clone https://github.com/AIGeniusInstitute/deep-think.git
cd deepthink

# 2. One-tap launch (auto-installs dependencies + compiles on first run)
make start

Open: http://localhost:9898

For public access, configure a reverse proxy with nginx/caddy yourself
```

Follow the setup wizard to complete initialization:

1. **Create an admin** — Customize username and password (no default account)
2. **Configure Claude API** — Fill in the API key and model (relay services supported; multiple providers configurable)
3. **Configure IM channels** (optional) — Feishu / Telegram / QQ / DingTalk / WeChat / Discord / WhatsApp
4. **Start chatting** — Send a message directly from the Web chat page

> All configuration is done via the Web interface, with no config files required. API keys are stored AES-256-GCM encrypted.


### Enabling Container Mode

The admin user defaults to host mode (no Docker needed) and works out of the box. For container mode (used automatically by member users after registration):

```bash
# Build the container image
./container/build.sh

# (Optional) Build the hardened sandbox image for code execution + browser automation
make sandbox-build
```

A container-mode primary workspace (`home-{userId}`) is created automatically when a new user registers — no extra configuration needed.

### Configuring Feishu Integration

1. Go to the [Feishu Open Platform](https://open.feishu.cn) and create an enterprise self-built app
2. Under the app's "Event Subscriptions", add: `im.message.receive_v1` (receive messages)
3. Under the app's "Permission Management", enable the following permissions:
   - `cardkit:card:write` (create and update cards)
   - `im:chat` / `im:chat:read` / `im:chat:readonly` (group information)
   - `im:message` (send messages)
   - `im:message.group_at_msg:readonly` (receive group @ messages)
   - `im:message.group_msg` (receive all group messages) — **sensitive permission**, requires admin approval. Without it, only @-Bot messages are processed in groups
   - `im:message.p2p_msg:readonly` (receive private-chat messages)
   - `im:resource` (get and upload image/file resources)

4. Publish the app version and wait for approval
5. In the DeepThink Web interface, under "Settings → IM Channels → Feishu", fill in the App ID and App Secret

Each user can independently configure Feishu app credentials in their personal settings, enabling per-user Feishu Bots.

> **Group mention control**: By default, groups require @-Bot to respond. Use `/require_mention false` to switch to all-message response (requires the `im:message.group_msg` permission).

> **Feishu topic groups**: After binding a Feishu topic group (`chat_mode=topic` or `group_message_type=thread`) to a workspace, each topic automatically creates an independent session Agent with its own context and message history. The Web interface switches to a vertical topic list with search and delete support. Unbinding automatically cleans up all topic sessions.


### Configuring Telegram Integration

1. In Telegram, find [@BotFather](https://t.me/BotFather), send `/newbot` to create a Bot
2. Save the returned Bot Token
3. In the DeepThink Web interface, under "Settings → IM Channels → Telegram", fill in the Bot Token
4. **Group usage**: To use the Bot in a Telegram group, send `/mybots` in BotFather → select the Bot → Bot Settings → Group Privacy → Turn off; otherwise the Bot can only receive `/` command messages


### Configuring QQ Integration

1. Go to the [QQ Open Platform](https://q.qq.com/qqbot/openclaw/index.html), scan the QR code with mobile QQ to register and log in
2. Create a bot, set the name and avatar
3. On the bot management page, get the **App ID** and **App Secret**
4. In the DeepThink Web interface, under "Settings → IM Channels → QQ", fill in the App ID and App Secret
5. **Pairing**: Generate a pairing code on the settings page, then send `/pair <pairing-code>` to the Bot in QQ to complete binding

> QQ Bot uses the official API v2 protocol, supporting C2C private chats and group @-Bot messages. In groups, the Bot only receives @-Bot messages. Supports streaming typewriter replies in C2C chats.


### Configuring DingTalk Integration

1. Go to the [DingTalk Open Platform](https://open.dingtalk.com) and create an enterprise internal app
2. Under App Management → Bots & Messaging, enable "Bot Configuration"
3. Select **Stream mode** (not HTTP callback mode) to receive messages
4. Get the app's **Client ID** (AppKey) and **Client Secret** (AppSecret)
5. In the DeepThink Web interface, under "Settings → IM Channels → DingTalk", fill in the Client ID and Client Secret

> DingTalk Bot supports both DM and group chats. In groups, the Bot only responds to @-Bot messages. Supports AI Card streaming typewriter effect.


### Configuring WeChat Integration

1. In the DeepThink Web interface, under "Settings → IM Channels → WeChat", enable the WeChat channel
2. Fill in the iLink Bot Token
3. Click "Scan to Pair" to generate a QR code
4. Scan the QR code with WeChat to complete binding

> WeChat messages are limited to 2000 characters; excess content is automatically chunked. Images from the WeChat CDN are downloaded and AES-decrypted before being passed to the Agent.


### Configuring Discord Integration

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application
2. Under the "Bot" tab, create a bot and copy its **Token**
3. Under "OAuth2 → URL Generator", select the `bot` and (optionally) `applications.commands` scopes, pick the required permissions (Send Messages, Read Message History, Attach Files), and open the generated URL to invite the bot to your server
4. In the DeepThink Web interface, under "Settings → IM Channels → Discord", fill in the Bot Token

> Discord supports both guild (server) channels and DMs. Long messages are auto-split at 2000 chars; replies use a 500ms-throttled streaming-edit typewriter effect, and an ack Reaction is added when the Agent starts working.


### Configuring WhatsApp Integration

1. In the DeepThink Web interface, under "Settings → IM Channels → WhatsApp", enable the WhatsApp channel
2. Click "Generate QR Code"
3. Scan the QR code with WhatsApp on your phone (Settings → Linked Devices)
4. Wait for the connection to establish

> WhatsApp integration uses the community-maintained Baileys library (WhatsApp Web protocol). Login state is persisted with multi-file auth, so you only scan the QR on first launch. Media (image / video / audio / document) messages are downloaded to the workspace. See [`docs/channels/whatsapp.md`](docs/channels/whatsapp.md) for details and risk notes.
### IM Slash Commands

In Feishu / Telegram / QQ / DingTalk / WeChat / Discord / WhatsApp, messages starting with `/` are intercepted as slash commands (unknown commands fall back to being treated as normal messages):

| Command | Alias | Purpose |
|------|------|------|
| `/list` | `/ls` | List all workspaces and conversations |
| `/status` | - | View the current workspace/conversation status |
| `/where` | - | View the current binding location and reply policy |
| `/bind <target>` | - | Bind to a specified workspace or Agent (e.g., `/bind myws` or `/bind myws/a3b`) |
| `/unbind` | - | Unbind back to the default workspace |
| `/new <name>` | - | Create a new workspace and bind the current group to it |
| `/recall` | `/rc` | AI-summarized recent conversation history |
| `/clear` | - | Clear the current conversation's session context |
| `/require_mention` | - | Toggle group response mode: `true` (require @) or `false` (respond to all) |


### Execution Modes

| Mode | Description | Target | Prerequisites |
|------|------|---------|---------|
| **Host mode** | Agent runs directly on the host, accessing the local filesystem | Admin primary workspace (`folder=main`) | Claude Agent SDK (auto-installed) |
| **Container mode** | Agent runs isolated in a Docker container, 40+ preinstalled tools | Member primary workspace (`folder=home-{userId}`) | Docker Desktop + built image |

The admin primary workspace defaults to host mode; a container-mode primary workspace is auto-created on member registration. You can also switch execution modes manually from the Web interface's session management.

### Container Toolchain

The container image is based on `node:22-slim` and ships with the following tools:

| Category | Tools |
|------|------|
| AI / Agent | Claude Code CLI, Claude Agent SDK, MCP SDK |
| Browser automation | Chromium, agent-browser |
| Programming languages | Node.js 22, Python 3 (pip / venv), Go |
| Build toolchain | build-essential, cmake, pkg-config |
| Text search | ripgrep (`rg`), fd-find (`fd`) |
| Multimedia processing | ffmpeg, ImageMagick, Ghostscript, Graphviz |
| Document conversion | Pandoc, poppler-utils (PDF tools) |
| Database clients | SQLite3, MySQL Client, PostgreSQL Client, Redis Tools |
| Network tools | curl, wget, openssh-client, dnsutils, iputils-ping, lsof |
| Feishu CLI | feishu-cli (prebuilt binary + Skills) |
| Shell | Zsh + Oh My Zsh (ys theme) |
| Others | git, jq, tree, file, shellcheck, zip/unzip, rsync, bc, patch |
## Technical Architecture

### Architecture Diagram

<p align="center">
  <img src="docs/architecture/deepthink-architecture.png" alt="DeepThink System Architecture" width="860" />
</p>


```mermaid
flowchart TD
    subgraph 接入层
        Feishu("飞书<br/>(WebSocket 长连接)")
        Telegram("Telegram<br/>(Bot API)")
        QQ("QQ<br/>(Bot API v2)")
        DingTalk("钉钉<br/>(Stream 长连接)")
        WeChat("微信<br/>(iLink Bot API)")
        Discord("Discord<br/>(Gateway WS)")
        WhatsApp("WhatsApp<br/>(Baileys)")
        Web("Web 界面<br/>(React 19 SPA)")
    end

    subgraph 主进程["主进程 (Node.js + Hono)"]
        Router["消息路由<br/>(2s 轮询 + 去重)"]
        Queue["并发队列<br/>(20 容器 + 5 宿主机进程)"]
        Scheduler["定时调度器<br/>(Cron / 间隔 / 一次性)"]
        WS["WebSocket Server<br/>(流式推送 + 终端)"]
        Auth["认证 & RBAC<br/>(bcrypt + HMAC Cookie)"]
        Config["配置管理<br/>(AES-256-GCM 加密)"]
        ProviderPool["提供商池 / 引擎<br/>(Claude/AtomCode/Codex/OpenCode)"]
        Billing["计费引擎<br/>(Plan + Wallet + Quota)"]
        Harness["Harness / Loop<br/>(版本化 + 自主循环)"]
        PaaS["PaaS / Marketplace<br/>(Agent 即服务)"]
    end

    subgraph 执行层
        Host["宿主机进程<br/>(Claude Code CLI)"]
        Container["Docker 容器<br/>(agent-runner)"]
        Sandbox["沙箱<br/>(代码执行 + 浏览器)"]
    end

    subgraph Agent["Agent 运行时"]
        SDK["Claude Agent SDK<br/>(query 循环)"]
        MCP["MCP Server<br/>(27 个工具)"]
        Stream["流式事件<br/>(30+ 种类型)"]
    end

    KB[("知识库<br/>(FTS5 + 向量)")]
    DB[("SQLite<br/>(WAL 模式)")]
    IPC["IPC 文件通道<br/>(原子读写)"]
    Memory["记忆系统<br/>(CLAUDE.md + memory/)"]

    Feishu --> Router
    Telegram --> Router
    QQ --> Router
    DingTalk --> Router
    WeChat --> Router
    Discord --> Router
    WhatsApp --> Router
    Web --> Router

    Router --> Queue
    Queue --> ProviderPool
    ProviderPool --> Host
    ProviderPool --> Container
    ProviderPool --> Sandbox
    Scheduler --> Queue
    Billing --> Queue
    Harness --> ProviderPool
    PaaS --> ProviderPool

    Host --> SDK
    Container --> SDK
    Sandbox --> SDK
    SDK --> MCP
    SDK --> Stream
    SDK --> KB

    MCP --> IPC
    IPC --> Router

    Stream --> WS
    WS --> Web

    Router --> DB
    Auth --> DB
    Billing --> DB
    SDK --> Memory

    class Feishu,Telegram,QQ,DingTalk,WeChat,Discord,WhatsApp,Web fe
    class Router,Queue,Scheduler,WS,Auth,Config,ProviderPool,Billing,Harness,PaaS svc
    class DB,KB db
    class Host,Container,Sandbox faas
    class SDK,MCP,Stream faas
    class IPC cfg
    class Memory cfg
```

**Data flow**: Messages enter the main process from the access layer (8 channels), are deduplicated and routed, then dispatched to the concurrency queue. The queue selects an API key / engine via the provider pool and starts a host process, Docker container, or sandbox. The agent-runner inside the container calls the Claude Agent SDK's `query()` function. Streaming events (30+ types: thinking, text, tool calls, hooks, tasks, memory recall, loops, usage, etc.) are passed back to the main process via the stdout marker protocol, then broadcast to Web clients via WebSocket or replied to each channel via IM APIs. The MCP Server provides 27 tools over a file-based IPC channel, enabling bidirectional communication between the Agent and the main process. The billing engine checks quota and balance before each request. The Harness/Loop layer snapshots and evolves the Agent's configuration and drives autonomous task loops.
### Tech Stack

| Layer | Technologies |
|------|------|
| **Backend** | Node.js 22 · TypeScript 5.9 · Hono · better-sqlite3 (WAL) · ws · node-pty · Pino · Zod 4 |
| **Frontend** | React 19 · Vite 6 · Zustand 5 · Tailwind CSS 4 · shadcn/ui · Radix UI · Lucide Icons · react-markdown · mermaid · recharts · @dnd-kit · xterm.js · @tanstack/react-virtual · PWA |
| **Agent** | Claude Agent SDK · Claude Code CLI · MCP SDK · IPC file channels |
| **Engines** | Claude Code · AtomCode · Codex · OpenCode (pluggable, daemon-managed) |
| **PaaS** | DB-backed Agent definitions · template marketplace · per-user quotas · admin review |
| **Harness / Loop** | Versioned harness manifests · autonomous task loops · per-iteration SDK review |
| **Autonomy** | Autonomy Layer (event bus + capability registry + 7-capability metrics) · Autonomous Mode (3 defense layers + 4 hard brakes) · Playwright E2E acceptance |
| **Sandbox** | Docker + seccomp + cgroups · Chromium CDP browser automation |
| **Container** | Docker (node:22-slim) · Chromium · agent-browser · Python · Go · 40+ preinstalled tools |
| **Security** | bcrypt (12 rounds) · AES-256-GCM · HMAC Cookie · RBAC · path-traversal protection · mount whitelist · cross-group ACL |
| **IM integrations** | @larksuiteoapi/node-sdk (Feishu) · grammY (Telegram) · QQ Bot API v2 · dingtalk-stream (DingTalk) · iLink Bot API (WeChat) · discord.js (Discord) · Baileys (WhatsApp) |

### Directory Structure

All runtime data lives under `data/`, auto-created at startup — no manual initialization required.

```
deepthink/
├── src/                          # Backend source
│   ├── index.ts                  #   Entry: message polling, IPC listening, container lifecycle
│   ├── web.ts                    #   Hono app, WebSocket, static files
│   ├── routes/                   #   28 route modules (auth / groups / files / config / monitor /
│   │                             #   memory / tasks / skills / admin / browse / agents /
│   │                             #   mcp-servers / plugins / usage / billing / bug-report /
│   │                             #   chat-trace / harness / loops / sandbox /
│   │                             #   agent-definitions / workspace-config / paas-admin /
│   │                             #   paas-agents / paas-embedding / paas-knowledge-bases /
│   │                             #   paas-marketplace / paas-share)
│   ├── feishu.ts                 #   Feishu connection factory (WebSocket long connection)
│   ├── feishu-streaming-card.ts  #   Feishu streaming card (typewriter + three-tier fallback)
│   ├── telegram.ts               #   Telegram connection factory (Bot API)
│   ├── qq.ts                     #   QQ connection factory (Bot API v2 WebSocket)
│   ├── qq-streaming-card.ts      #   QQ streaming card (stream_messages typewriter)
│   ├── dingtalk.ts               #   DingTalk connection factory (Stream protocol)
│   ├── dingtalk-streaming-card.ts#   DingTalk AI Card streaming controller
│   ├── wechat.ts                 #   WeChat connection factory (iLink Bot API)
│   ├── whatsapp.ts               #   WhatsApp connection factory (Baileys)
│   ├── discord.ts                #   Discord connection factory (discord.js Gateway)
│   ├── discord-streaming-edit.ts #   Discord streaming-edit controller
│   ├── im-manager.ts             #   IM connection pool (per-user seven-channel management)
│   ├── im-safety/                #   IM safety primitives (processing lock + stale detector)
│   ├── container-runner.ts       #   Docker / host process management
│   ├── group-queue.ts            #   Concurrency control queue
│   ├── provider-pool.ts          #   Multi-provider load balancing
│   ├── atomcode-daemon-manager.ts#   Pluggable engine daemon lifecycle
│   ├── harness-*.ts              #   Harness Engineering (registry / eval / meta-loop)
│   ├── loop-orchestrator.ts      #   Loop Engineering orchestrator
│   ├── supervisor.ts             #   Supervisor SubAgent (intent triage)
│   ├── plugin-*.ts               #   Claude Code Plugins (catalog / importer / materializer)
│   ├── embedding.ts              #   KB vector embeddings
│   ├── cross-group-acl.ts        #   Cross-group IPC authorization
│   ├── office-converter.ts       #   Office → PDF preview + text extraction
│   ├── i18n-languages.ts        #   29-language i18n
│   ├── billing.ts                #   Billing engine (plans, wallet, quota)
│   ├── runtime-config.ts         #   AES-256-GCM encrypted config
│   ├── task-scheduler.ts         #   Scheduled-task scheduler
│   ├── script-runner.ts          #   Script-task executor
│   ├── file-manager.ts           #   File security (path-traversal protection)
│   ├── mount-security.ts         #   Mount whitelist / blacklist
│   └── db.ts                     #   SQLite data layer (Schema v1→v51)
│
├── web/                          # Frontend (React + Vite)
│   └── src/
│       ├── pages/                #   26 pages
│       ├── components/           #   UI components (chat / settings / billing / monitor / ...)
│       ├── stores/               #   21 Zustand stores
│       └── api/client.ts         #   Unified API client
│
├── container/                    # Agent container
│   ├── Dockerfile                #   Container image definition
│   ├── build.sh                  #   Build script
│   ├── sandbox/                  #   Hardened sandbox image (code exec + browser)
│   ├── agent-runner/             #   In-container execution engine
│   │   └── src/
│   │       ├── index.ts          #     Agent main loop + streaming events
│   │       └── mcp-tools.ts       #     27 MCP tools
│   └── skills/                   #   Project-level Skills
│
├── shared/                       # Cross-project shared type definitions
│   ├── stream-event.ts           #   StreamEvent type single source of truth (30+ types)
│   ├── channel-prefixes.ts       #   IM channel prefix mapping (7 IM channels)
│   └── image-detector.ts         #   Image MIME detection
│
├── scripts/                      # Build helper scripts
│   ├── sync-stream-event.sh      #   Sync shared/ types to each subproject
│   └── check-stream-event-sync.sh#   Validate type-copy consistency
│
├── config/                       # Project config
│   ├── default-groups.json       #   Pre-registered groups
│   ├── mount-allowlist.json      #   Container mount whitelist
│   └── global-claude-md.template.md # Global CLAUDE.md template
│
├── desktop/                      # Desktop Electron shell (macOS / Windows / Linux)
│
├── data/                         # Runtime data (auto-created at startup)
│   ├── db/messages.db            #   SQLite database (WAL mode)
│   ├── groups/{folder}/          #   Session working directory (Agent read/write)
│   │   ├── downloads/{channel}/  #     IM file downloads (by date subdirectory)
│   │   └── CLAUDE.md             #     Session-private memory
│   ├── groups/user-global/{id}/  #   User global memory directory
│   ├── sessions/{folder}/.claude/#   Claude session persistence
│   ├── ipc/{folder}/             #   IPC channels (input / messages / tasks)
│   ├── env/{folder}/env          #   Container environment-variable file
│   ├── memory/{folder}/          #   Date memory
│   └── config/                   #   Encrypted config files
│
└── Makefile                      # Common commands
```
### Development Guide

#### First-Time Install

```bash
make install              # Install root project dependencies + compile agent-runner
make install-host-tools   # Install external tools needed by host mode (feishu-cli, agent-browser, uv) + refresh builtin-skills cache
```

`make install` automatically fixes the executable permission of node-pty's `spawn-helper` (on macOS arm64, the prebuilt binary occasionally lacks the +x bit, which would break Web-terminal PTY mode).

#### Daily Development

```bash
make dev              # Start frontend + backend in parallel (hot reload); auto-installs deps + builds container image on first run
make dev-backend      # Start backend only (tsx runs TS directly, no pre-build needed)
make dev-web          # Start frontend only (Vite at 5173)
make status           # View service status (processes, ports, logs, Docker containers)
make logs             # Stream logs live (only effective when manually backgrounded, e.g. make start > /tmp/deepthink.log 2>&1 &)
make stop             # Stop the service (pm2 stop if pm2-managed, otherwise kill the port-listener process)
```

`make dev` auto-detects whether `package.json` is newer than `node_modules` and re-runs `make install` if so; it also ensures the Docker image exists (required for container mode). If pm2 is active on the system, it pauses pm2 first to release the port and restores it on exit.

#### Build & Type Checking

```bash
make build            # Compile everything (backend + frontend + agent-runner, includes sync-types)
make build-backend    # Backend only
make build-web        # Frontend only
make typecheck        # Full TypeScript typecheck (backend + frontend + agent-runner)
make typecheck-backend    # Backend only
make typecheck-web        # Frontend only
make typecheck-agent-runner  # agent-runner only
make format           # Format code with Prettier
make format-check     # Check formatting only (for CI, no file modifications)
make test             # Run constraint tests (vitest; required before/after refactoring)
make sync-types       # Sync shared/ type definitions to each subproject (stream-event.ts, image-detector.ts, channel-prefixes.ts)
make clean            # Clean all build artifacts (dist/, web/dist/, container/agent-runner/dist/)
```

> After modifying `shared/stream-event.ts`, you must run `make sync-types` to sync to the three subprojects, otherwise types will be inconsistent. `make build` and `make typecheck` trigger the sync automatically.
#### Production Deployment

```bash
make start            # One-tap launch for production (foreground blocking, logs to terminal)
make update-sdk       # Manually update the Claude Agent SDK in agent-runner + main service to the latest version
make ensure-latest-sdk  # Auto-check before startup whether the SDK has a new version (update if so, skip otherwise; built into make start)
make sandbox-build    # Build the hardened sandbox image deepthink-sandbox:latest (code execution + browser automation)
```

For background running: `make start > /tmp/deepthink.log 2>&1 &`, then use `make logs` to stream logs, `make status` for process status, and `make stop` to stop the service.

#### Admin Account Management

```bash
make admin-create     # Create an admin account (USERNAME=xxx [PASSWORD=xxx]; omit PASSWORD for interactive input)
make admin-passwd      # Change an admin's password (USERNAME=xxx [PASSWORD=xxx]; clears all of that account's old login sessions)
```

#### Data Management

```bash
make reset-init       # Reset to first-install state (clears database, config, workspaces, memory, sessions, IPC, logs)
make backup           # Back up runtime data to deepthink-backup-{date}.tar.gz
make restore          # Restore from the latest backup (or make restore FILE=xxx.tar.gz to specify a file)
make migrate-data     # Migrate an in-repo legacy ./data directory out to the external DATA_DIR
```

> `make reset-init` clears the entire `data/` directory — use only for testing the setup wizard or starting completely fresh. Use with caution in production.

#### Desktop Packaging

Package DeepThink as a standalone executable app (macOS `.dmg` / Windows `.exe` / Linux `.AppImage`); see `CLAUDE.md` §2.6 for details.

```bash
make desktop-build      # Compile the desktop Electron shell (includes build + sync-types + npm install)
make desktop-fetch-node # Fetch the Node.js binary for the current platform into desktop/dev-resources/node (required before first packaging)
make desktop-rebuild-natives # Recompile native modules (better-sqlite3 etc.) against the bundled Node ABI to avoid runtime ABI mismatch
make desktop-dev        # Desktop dev mode: launch the Electron shell loading the local backend
make desktop-pack-mac   # Package macOS .dmg (arm64 + x64, must run on macOS)
make desktop-pack-win   # Package Windows .exe (must run on a Windows runner)
make desktop-pack-linux # Package Linux AppImage/.deb (must run on a Linux runner)
```

Build artifacts go to `desktop/release/`, including the main `.dmg` / `.exe` / `.AppImage` file and the `.blockmap` (for incremental updates).

> Cross-platform packaging must run on the corresponding platform's runner (an electron-builder limitation). macOS can produce both arm64 + x64 dmg builds; Windows and Linux can each only run on their native platform.

#### Release Publishing

DeepThink offers two ways to publish to a GitHub Release: manual `make release` (suitable for quick single-platform releases) and fully automated GitHub Actions (suitable for official version releases, with three platforms built in parallel).

**Option 1: Manual release (`make release`)**

Prerequisites: `make desktop-pack-*` has produced artifacts, a tag has been created and pushed to the remote.

```bash
# 1. Create and push a tag
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0

# 2. Build artifacts locally (macOS example)
make desktop-pack-mac

# 3. Publish to GitHub Release (requires: brew install gh && gh auth login)
make release VERSION=v1.0.0

# Delete on accidental release
make release-delete VERSION=v1.0.0
```

**Option 2: GitHub Actions fully automated (`.github/workflows/release.yml`)**

Triggered automatically when a `v*` tag is pushed; three platforms build in parallel and a Release is auto-created. You can also trigger it manually via `workflow_dispatch` on the GitHub repo's Actions page. To customize release notes, write the content to `docs/release-notes/v1.0.0.md` before pushing the tag.

#### Help & Ports

```bash
make help    # List all available make commands with descriptions
```

| Service | Default Port | Description |
|------|---------|------|
| Backend | 9898 | Hono + WebSocket |
| Frontend dev server | 5173 | Vite, proxies `/api` and `/ws` to the backend (dev mode only) |

#### Custom Ports

**Production mode** (`make start`): Only the backend service runs; the frontend is served as static files by the backend. Change the port via the `WEB_PORT` environment variable:

```bash
WEB_PORT=8080 make start
# Open http://localhost:8080
```

**Dev mode** (`make dev`): The frontend Vite dev server (`5173`) and backend (`9898`) run separately; access `5173` during development. To point the frontend proxy at a non-default backend, set `VITE_API_PROXY_TARGET` and `VITE_WS_PROXY_TARGET`.
### Environment Variables

The following are optional overrides. We recommend using the Web setup wizard to configure the Claude API and IM credentials (encrypted storage).

| Variable | Default | Description |
|------|--------|------|
| `WEB_PORT` | `9898` | Web service port |
| `ASSISTANT_NAME` | `DeepThink` | Assistant display name |
| `CONTAINER_IMAGE` | `deepthink-agent:latest` | Agent container image |
| `CONTAINER_TIMEOUT` | `1800000` (30min) | Container hard timeout (overridable via Web settings) |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10MB) | Max output size per run (overridable via Web settings) |
| `IDLE_TIMEOUT` | `1800000` (30min) | Container idle keepalive (overridable via Web settings) |
| `MAX_CONCURRENT_CONTAINERS` | `20` | Max concurrent containers (overridable via Web settings) |
| `MAX_CONCURRENT_HOST_PROCESSES` | `5` | Host-process concurrency cap (overridable via Web settings) |
| `MAX_FILE_SIZE_MB` | `50` | File-size limit (MB) shared by Web uploads and IM downloads (overridable via Web settings) |
| `MAX_LOGIN_ATTEMPTS` | `5` | Failed-login lockout threshold (overridable via Web settings) |
| `LOGIN_LOCKOUT_MINUTES` | `15` | Lockout duration in minutes (overridable via Web settings) |
| `AUTO_COMPACT_WINDOW` | `0` (disabled) | SDK auto-compaction trigger point in tokens; 0 = off (overridable via Web settings) |
| `TASK_BACKFILL_GRACE_MS` | `300000` (5min) | Late-tolerance window for scheduled tasks after restart (overridable via Web settings) |
| `TRUST_PROXY` | `false` | Trust the `X-Forwarded-For` header from reverse proxies |
| `CORS_ALLOWED_ORIGINS` | empty (localhost only) | Allowed origins for public-domain access; required for WebSocket upgrade defense (CSWSH). Comma-separated domains or `*` |
| `TZ` | System timezone | Timezone for scheduled tasks |

> More runtime parameters (container timeout, concurrency limits, login protection, billing settings, etc.) can be configured under "Settings → System Settings" in the Web interface — no environment variables needed. `CORS_ALLOWED_ORIGINS` can be written to the project-root `.env` (auto-loaded by `src/load-env.ts` on startup).

### Admin Password Recovery

```bash
npm run reset:admin -- <username> <new-password>
```

### Data Reset

```bash
make reset-init

# Or manually:
rm -rf data store groups
```
## Contributions

Issues and Pull Requests are welcome!

### Development Workflow

1. Fork the repo and clone it locally
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Develop and test: `make dev` to start the dev environment, `make typecheck` for type checks
4. Commit and push to your Fork
5. Open a Pull Request against the `main` branch

### Commit Conventions

Commit messages use Simplified Chinese, in the format: `type: description`

```
修复: 侧边栏下拉菜单无法点击
新增: Telegram Bot 集成
重构: 统一消息路由逻辑
```

### Project Structure

The project contains four independent Node.js projects, each with its own `package.json` and `tsconfig.json`:

| Project | Directory | Purpose |
|------|------|------|
| Main service | `/` (root) | Backend service (28 route modules) |
| Web frontend | `web/` | React SPA (26 pages, 21 stores) |
| Agent Runner | `container/agent-runner/` | In-container / on-host execution engine |
| Desktop shell | `desktop/` | Electron packaging for macOS / Windows / Linux |

Additionally, the `shared/` directory holds cross-project shared type definitions (StreamEvent, Channel Prefixes, Image Detector), synced to each subproject at build time via `make sync-types`.

## Star History

<a href="https://www.star-history.com/?repos=AIGeniusInstitute%2Fdeepthink&type=timeline&logscale=&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=AIGeniusInstitute/deepthink&type=timeline&theme=dark&logscale&legend=top-left&sealed_token=y_bjrbvLjoYtxk11EJ9ZFlIZvYc-4-gic2JJOV7sbiCp4yl86pjY3JI27i1djHKQn5hauajrtyNYSxWGK-x1z_YWleCN_MOAqkWNIPu2EBsKXS6ALOu6oA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=AIGeniusInstitute/deepthink&type=timeline&logscale&legend=top-left&sealed_token=y_bjrbvLjoYtxk11EJ9ZFlIZvYc-4-gic2JJOV7sbiCp4yl86pjY3JI27i1djHKQn5hauajrtyNYSxWGK-x1z_YWleCN_MOAqkWNIPu2EBsKXS6ALOu6oA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=AIGeniusInstitute/deepthink&type=timeline&logscale&legend=top-left&sealed_token=y_bjrbvLjoYtxk11EJ9ZFlIZvYc-4-gic2JJOV7sbiCp4yl86pjY3JI27i1djHKQn5hauajrtyNYSxWGK-x1z_YWleCN_MOAqkWNIPu2EBsKXS6ALOu6oA" />
 </picture>
</a>

## License

[MIT](LICENSE)

## Languages

- [English](README.md)
- [简体中文](README.zh-CN.md)
- [Español](README.es.md)
- [हिन्दी](README.hi.md)
- [العربية](README.ar.md)
- [বাংলা](README.bn.md)
- [Português](README.pt.md)
- [Русский](README.ru.md)
- [日本語](README.ja.md)
- [Deutsch](README.de.md)
- [Français](README.fr.md)
- [Bahasa Indonesia](README.id.md)
- [اردو](README.ur.md)
- [मराठी](README.mr.md)
- [తెలుగు](README.te.md)
- [Türkçe](README.tr.md)
- [தமிழ்](README.ta.md)
- [한국어](README.ko.md)
- [Tiếng Việt](README.vi.md)
- [Italiano](README.it.md)
- [Polski](README.pl.md)
- [Українська](README.uk.md)
- [Nederlands](README.nl.md)
- [ไทย](README.th.md)
- [ગુજરાતી](README.gu.md)
- [Bahasa Melayu](README.ms.md)
- [ಕನ್ನಡ](README.kn.md)
- [فارسی](README.fa.md)
- [Svenska](README.sv.md)
- [Čeština](README.cs.md)


## About Author

- [AI天才研究院](https://gitcode.com/AIGeniusInstitute)

- [博客](https://blog.csdn.net/universsky2015)

- [Gitcode](https://gitcode.com/AIGeniusInstitute/deepthink)

- [Github](https://github.com/AIGeniusInstitue)

- [光剑图书馆: 全球免费开放的电子图书馆 World Free eBook](https://universsky.github.io/)



---

## 捐赠

> The AI Genius Institute is an independent research blog and intellectual laboratory dedicated to deep thinking on artificial general intelligence, cutting-edge technology deconstruction, and cognitive framework construction. We break free from the shackles of fragmented information and reject superficial AI popularization. With rigorous research perspectives, crystal-clear logical analysis, and forward-looking industry insights, we delve deep into the underlying logic of AI, technological iteration, paradigms of thought, and practical applications—building a high-quality, substance-rich, and intellectually deep cognitive hub for creators, developers, researchers, industry practitioners, and AI enthusiasts.


Donate to AI Genius Institute:


| 微信                                                    | 支付宝                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| <img src="static/wechat.jpeg" width="300" height="350"> | <img src="static/alipay.jpeg" width="300" height="350"> |

