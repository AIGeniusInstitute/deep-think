# Contributing to DeepThink

First off, thanks for taking the time to contribute! 🎉

DeepThink is a self-hosted, multi-user local AI Agent Loop Engineering system. This guide will walk you through getting set up and submitting your first contribution.

> By participating in this project, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Development Environment Setup](#development-environment-setup)
- [Project Structure](#project-structure)
- [Branch & Commit Conventions](#branch--commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs & Requesting Features](#reporting-bugs--requesting-features)
- [Good First Issues](#good-first-issues)
- [Coding Style](#coding-style)

## Prerequisites

- **Node.js** ≥ 20
- **npm** (bundled with Node.js)
- **Docker** (optional, only for container mode / sandboxed execution)
- **Git**

## Development Environment Setup

```bash
# 1. Fork & clone
git clone https://github.com/AIGeniusInstitute/deepthink.git
cd deepthink

# 2. Install dependencies
npm install

# 3. Sync shared type definitions across subprojects
make sync-types

# 4. Start the dev environment (backend + frontend hot-reload)
make dev
```

The frontend dev server is available at `http://localhost:5173` by default and proxies API requests to the backend on port `9898`. The first run will walk you through the setup wizard.

## Project Structure

DeepThink contains four independent Node.js projects, each with its own `package.json` and `tsconfig.json`:

| Project | Directory | Purpose |
|------|------|------|
| Main service | `/` (root) | Backend service (28 route modules) |
| Web frontend | `web/` | React SPA (26 pages, 21 stores) |
| Agent Runner | `container/agent-runner/` | In-container / on-host execution engine |
| Desktop shell | `desktop/` | Electron packaging for macOS / Windows / Linux |

The `shared/` directory holds cross-project shared type definitions (StreamEvent, Channel Prefixes, Image Detector), synced to each subproject at build time via `make sync-types`. **If you touch anything in `shared/`, re-run `make sync-types` before committing.**

## Branch & Commit Conventions

- **Branch naming**: `feature/<topic>`, `fix/<topic>`, `docs/<topic>`.
- **Commit messages**: written in Simplified Chinese, in the format `type: description`.

```
修复: 侧边栏下拉菜单无法点击
新增: Telegram Bot 集成
重构: 统一消息路由逻辑
```

Keep commits focused — one logical change per commit makes review faster.

## Pull Request Process

1. Fork the repo and create a feature branch from `main`: `git checkout -b feature/your-feature`.
2. Develop and verify locally:
   - `make dev` — start the dev environment
   - `make typecheck` — type checks must pass
   - `make test` — tests must pass (when applicable)
3. If you changed shared types, run `make sync-types` and commit the synced copies.
4. Push to your fork and open a Pull Request against the `main` branch.
5. Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) — describe the problem, the fix, and how you tested it.
6. A maintainer will review. Small, well-described PRs get merged faster.

### PR Checklist

- [ ] `make typecheck` passes
- [ ] `make test` passes (when applicable)
- [ ] Shared types synced via `make sync-types` (if touched)
- [ ] Manually verified the core scenario
- [ ] Linked the related issue (`Closes #xxx`)
- [ ] Commit messages follow the convention above

## Reporting Bugs & Requesting Features

- **Bug report**: open an issue using the **Bug 报告** template. Include user symptoms, reproduction steps, expected vs actual behavior, and environment info.
- **Feature request**: open an issue using the **功能请求** template. Describe the background, expected behavior, and any alternatives you considered.

## Good First Issues

Look for issues labeled [`good first issue`](https://github.com/AIGeniusInstitute/deepthink/labels/good%20first%20issue) — these are scoped to be approachable for newcomers. If you start one, leave a comment so others know it's being worked on, and ask in the issue thread if you get stuck.

## Coding Style

- Follow the existing style of the file you're editing — the project uses Prettier (see `.prettierrc`).
- Prefer surgical changes: touch only what's necessary for your fix, leave refactoring for a separate PR.
- When in doubt, open an issue to discuss the approach before writing a lot of code.

---

Questions? Open an issue and we'll help. Thanks again for contributing!
