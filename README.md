# pi-cc-memory

Project-scoped, file-based memory for the [Pi](https://pi.dev) coding agent,
modeled on Claude Code's auto memory.

Memory is plain Markdown: an index (`MEMORY.md`) plus one file per topic with a
short frontmatter block. The model reads and writes it through a dedicated tool,
so memory survives sessions, compactions and worktrees without a database.

> Status: **M1 (minimum viable)**. Explicit read/write, lifecycle injection and
> optional recall work. Background extraction and consolidation are planned for
> M3 and are deliberately not wired. See [docs/milestones.md](docs/milestones.md).

## Install

```bash
pi install ./path/to/pi-cc-memory      # local checkout
pi install git:github.com/escapeWu/pi-cc-memory
```

Or try one invocation without installing:

```bash
pi -e ./path/to/pi-cc-memory
```

## What it does

- Injects a memory maintenance policy into the system prompt on every run.
- Injects `MEMORY.md` by default, so the model can navigate topics without
  loading their bodies.
- Gives the model a `memory` tool:
  `status | list | read | write | forget | index | search`.
- Optionally recalls relevant topics before the first answer, using the session
  model to select from a frontmatter manifest.
- Adds `/memory` for a human-readable status summary.

## Storage

```text
~/.pi/agent/cc-memory/projects/<project>-<hash8>/
├── MEMORY.md
├── feedback_testing.md
└── infra_deploy.md
```

The store is keyed by the canonical Git root, so linked worktrees share memory.
The plugin writes under its own `cc-memory/` subtree: it never adopts or
overwrites an existing `~/.pi/agent/memory` installation.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_CC_MEMORY_DIR` | — | Exact store root for this project (absolute or `~/...`) |
| `PI_CC_MEMORY_RECALL` | `0` | `1` enables recall and stops injecting the index |
| `PI_CC_MEMORY_RECALL_MODEL` | session model | `provider/model` used for selection |
| `PI_CC_MEMORY_RECALL_FILES` | `5` | Max topics surfaced per request |
| `PI_CC_MEMORY_RECALL_FILE_BYTES` | `4096` | Per-file surfacing cap |
| `PI_CC_MEMORY_RECALL_SESSION_BYTES` | `61440` | Per-session surfacing budget |
| `PI_CC_MEMORY_RECALL_TIMEOUT_MS` | `8000` | Selection timeout; failure means no recall |
| `PI_CC_MEMORY_INDEX_LINES` | `200` | Index line budget |
| `PI_CC_MEMORY_INDEX_BYTES` | `24000` | Index UTF-8 byte budget |
| `PI_CC_MEMORY_TOPIC_BYTES` | `32768` | Per-topic UTF-8 byte budget |

## Memory format

```markdown
---
name: 集成测试约定
description: 数据库行为及迁移验证的适用条件
type: feedback
---

集成测试需要真实数据库。

**Why:** 用户曾遇到 mock 测试通过、生产迁移失败。
**How to apply:** 修改数据库行为及迁移时采用。
```

Types: `user`, `feedback`, `project`, `reference`. These are content
categories, not storage scopes — every type lives in the same project store.

## Development

```bash
npm install --include=dev
npm run check     # tsc --noEmit
npm test          # node --test
npm run lint      # biome
```

Core logic (`src/core/`) has no Pi imports and is tested without a runtime.

## Safety

- Topic paths are validated; absolute paths, traversal, hidden paths, non-Markdown
  targets and `MEMORY.md` itself are rejected.
- Symlinked topics and paths resolving outside the store are refused.
- Writes are atomic (temp file + rename) and serialized per store in-process.
- Index writes are capped by line and real UTF-8 byte budgets.
- A failed index update is reported, never silently treated as success.
- Recall is best-effort and bounded; a slow or failing selector cannot fail a turn.

## Documents

- [docs/claude-code-memory-pipeline.md](docs/claude-code-memory-pipeline.md) —
  analysis of the reference implementation this design is derived from.
- [docs/architecture.md](docs/architecture.md) — layers, storage, gaps.
- [docs/milestones.md](docs/milestones.md) — M1, M2, M3 and exit criteria.

## License

MIT
