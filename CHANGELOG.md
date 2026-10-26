# Changelog

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
