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
npm run lint                # biome check src test scripts bench
npm run bench               # L1 store cost + L2 offline recall quality (no network); see bench/README.md
PI_CC_MEMORY_LIVE_MODEL=provider/model npm run verify:live  # M1, explicit network calls
PI_CC_MEMORY_LIVE_MODEL=provider/model npm run verify:m2    # M2, synthetic data only
```

`bench/` is measurement tooling (synthetic data, temp dirs). It may import `src/` but
nothing in `src/` may import it; `npm run bench:live` makes explicit network calls.

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
- All store mutations use `withStoreLock`, including snapshots and restore. Keep
  the same heartbeat/stale policy across writers; never bypass it with only a mutex.
- Forget records recovery data before deletion; restore cannot overwrite newer
  content. Index failures must be reported and recovery evidence retained.
- Settings use `env > project > global > defaults` per field; no project-controlled
  store roots. Reload effective configuration for each call.
- Session notes are branch custom entries, not project/global topics. Keep native
  compaction cut points/file tracking and fall back when note generation fails.
- Budgets are real UTF-8 bytes, not string length.
- Recall is best-effort: timeout, model error or bad JSON means no recall, never a
  failed turn.
- Do not mark a milestone done in `docs/milestones.md` without verifying its exit
  criteria in a real Pi session.

## Milestone discipline

M1 is minimum viable: explicit read/write plus injection. M2 adds session memory
cooperation and storage hardening. M3 adds background extraction and
consolidation. Do not pull M3 behavior into M1 wiring.
