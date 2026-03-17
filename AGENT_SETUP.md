# AGENT_SETUP.md — AI Agent Onboarding Guide

> **This document is written for AI agents.**
> If you are an AI agent (Claude Code, Codex, Gemini, Antigravity, Cursor, Amp, or any other coding assistant), read this file to understand the project and navigate to the right guide.

---

## Project Overview

This repository is a **stack-agnostic AI coding agent orchestration harness** based on the [OpenAI Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md).

### What it does

1. **Receives a Linear webhook** when an issue moves to "In Progress"
2. **Creates an isolated git worktree** per issue at `{WORKSPACE_ROOT}/{issue-key}/`
3. **Spawns a coding agent** (claude, gemini, or codex) in that worktree with a rendered prompt from `WORKFLOW.md`
4. **Monitors the agent**, handles timeouts and retries
5. **The agent** reads `AGENTS.md`, implements the issue, commits, opens a PR
6. **CI validates** the PR → human reviews architecture → merge → worktree GC

### What Symphony does NOT do

- Symphony **never writes to Linear**. Agents write to Linear (status changes, comments).
- Symphony is a **scheduler and runner only**.

---

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Copy and fill environment variables
cp .env.example .env
# Edit .env with your Linear API key, webhook secret, etc.

# 3. Start the orchestrator
bun run src/main.ts

# Orchestrator listens on :8080
# POST /webhook  — Linear webhook receiver
# GET  /status   — Runtime state
# GET  /health   — Health check
```

See [`docs/guides/environment-setup.md`](docs/guides/environment-setup.md) for detailed Linear setup instructions.

---

## Navigate to What You Need

| Task | Read this |
|---|---|
| **First time setup** (install, .env, Linear UUIDs) | [`docs/guides/environment-setup.md`](docs/guides/environment-setup.md) |
| **Implement a Symphony component** | [`docs/guides/implementation-guide.md`](docs/guides/implementation-guide.md) |
| **Code style, git workflow, common mistakes** | [`docs/guides/conventions.md`](docs/guides/conventions.md) |
| **Pre-ship checklist, conformance audit** | [`docs/guides/conformance-checklist.md`](docs/guides/conformance-checklist.md) |

---

## Key Files (Always Read First)

| File | Why |
|---|---|
| `AGENTS.md` | Project conventions, golden principles, component overview — **read this first** |
| `WORKFLOW.md` | The YAML config + agent prompt template |
| `.env.example` | All required environment variables |
| `docs/architecture/LAYERS.md` | Dependency direction rules — violating this breaks CI |
| `docs/architecture/CONSTRAINTS.md` | 7 forbidden patterns with code examples |

---

## Primary Context Files

### AGENTS.md — The Source of Truth

`AGENTS.md` is the single source of truth for all agents. It contains:
- Build & test commands
- Architecture overview (7 Symphony components)
- Security rules
- Git workflow
- Conventions and golden principles
- Metrics

**Always read `AGENTS.md` before starting any task in this repository.**

### WORKFLOW.md — The Contract File

`WORKFLOW.md` has two parts separated by `---`:
1. **YAML front matter**: Orchestrator configuration (tracker, workspace, agent, concurrency)
2. **Prompt body**: The template rendered and sent to the agent for each issue

The `$VAR` syntax in YAML references environment variables. The `{{variable}}` syntax in the prompt body is filled at runtime.

### docs/ — Detailed Specifications

```
docs/specs/           ← Component-by-component interface specs (read before implementing)
docs/architecture/    ← Layer rules + forbidden patterns + stack-specific enforcement
docs/stacks/          ← Quick-start guides per language (TypeScript / Python / Go)
docs/harness/         ← Security, observability, entropy management, feedback loops
docs/guides/          ← Step-by-step guides (environment, implementation, conventions, checklist)
```
