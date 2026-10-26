# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A Pi coding-agent extension that provides project/global Markdown memory. It is
derived from an analysis of Claude Code's memory pipeline
(`docs/claude-code-memory-pipeline.md`), not a copy of that codebase.

## Commands

```bash
npm install --include=dev   # this machine has npm omit=dev globally
npm run check               # tsc --noEmit
npm test                    # core/adapter tests + actual SDK integration tests
npm run test:integration    # actual Pi SDK sessions, deterministic provider
npm run lint                # biome check src test scripts
PI_CC_MEMORY_LIVE_MODEL=provider/model npm run verify:live  # explicit network calls, synthetic data
```

There is no build step: Pi loads `src/extension.ts` through jiti.

## Structure rules

- `src/core/` must not import `@earendil-works/*`. It is host-neutral and unit
  tested without a Pi runtime.
- `src/adapters/` owns host I/O: filesystem, model registry, session entries.
- `src/extension.ts` is the only place that registers Pi tools, commands and
  lifecycle handlers.
- `src/services/` holds M3 placeholders. Do not call them from M1 wiring; keep the
  "not implemented" failure explicit.

## Invariants to preserve

- Never write into `~/.pi/agent/memory` or `~/.claude`. The default roots are
  `<agentDir>/cc-memory/projects/<slug>/` and `<agentDir>/cc-memory/global/`.
- Scope is explicit. Never infer `global` vs `project` from the memory type; the
  type/scope mismatch is only a warning. A disabled global store must fail loudly,
  never fall back to a project write.
- Project identity is the canonical Git root, so worktrees share one store.
- Topic paths come from the model: validate before any filesystem call, reject
  symlinks and escapes.
- A topic write and its index update happen under the per-store mutex; report a
  failed index update instead of claiming success.
- Budgets are real UTF-8 bytes, not string length.
- Recall is best-effort: timeout, model error or bad JSON means no recall, never a
  failed turn.
- Do not mark a milestone done in `docs/milestones.md` without verifying its exit
  criteria in a real Pi session.

## Milestone discipline

M1 is minimum viable: explicit read/write plus injection. M2 adds session memory
cooperation and storage hardening. M3 adds background extraction and
consolidation. Do not pull M3 behavior into M1 wiring.
