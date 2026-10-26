# Changelog

## 0.2.0 — two-tier memory

- Global store at `<agentDir>/cc-memory/global/` for cross-project facts.
- Explicit `scope` (`project | global`) on the `memory` tool; the type taxonomy is
  advisory only and a mismatch returns a warning.
- `PI_CC_MEMORY_GLOBAL=0` disables the global tier: no injection, no recall, and
  explicit errors for global reads/writes instead of silent project fallback.
- `PI_CC_MEMORY_DEFAULT_SCOPE` and `PI_CC_MEMORY_GLOBAL_DIR` configuration.
- Both indexes injected (global first), recall manifests qualified as `scope:path`.
- `list`, `read`, `forget`, `search` and `/memory` report the resolved scope;
  `forget` reports when the path still exists in the other store.

## 0.1.0 — M1 skeleton

- Project identity from the canonical Git root, with a hashed, readable slug.
- Markdown memory store: topic files, `MEMORY.md` index, atomic writes and
  in-process write serialization.
- Real UTF-8 byte budgets for the index and topic files.
- Path validation, symlink and escape rejection.
- `memory` tool: status / list / read / write / forget / index / search.
- Lifecycle wiring for `session_start`, `before_agent_start`,
  `session_shutdown`, plus `/memory`.
- Optional recall: frontmatter manifest, model selection, per-file and
  per-session budgets, best-effort degradation.
- M3 extraction and consolidation boundaries declared but not implemented.
