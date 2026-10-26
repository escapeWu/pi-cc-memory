# Architecture

`pi-cc-memory` is a Pi coding-agent extension. M1 is a working project memory
store plus explicit read/write tools. Background extraction (M3) is not wired.

## Layers

```text
src/extension.ts          Pi lifecycle wiring, tool, /memory command
src/config.ts             env-driven configuration for one project store
src/core/                 host-neutral logic (no Pi imports)
  types.ts                memory types, records, results
  format.ts               Markdown codec, index, budgets, path validation
  identity.ts             canonical Git root -> project slug
  scopes.ts               project/global scope, type-vs-scope advisory
  policy.ts               model-facing maintenance rules
  store.ts                single owner of one MEMORY.md + its topic files
  router.ts               routes operations to project and/or global store
  recall.ts               candidate scan, injected selector, budget, search
src/adapters/             host I/O (Pi + filesystem)
  filesystem.ts           atomic writes, bounded reads, keyed mutex
  pi-model.ts             relevance selection through the model registry
  pi-session.ts           branch-scoped state (recall usage, M3 cursor)
src/services/             M3 placeholders, never called by M1 wiring
  extraction.ts
  consolidation.ts
```

Dependency direction is `extension -> adapters -> core`. `core/` must not import
`@earendil-works/*` so it can be tested and reused without a Pi runtime.

## Storage

Two store roots:

```text
<agentDir>/cc-memory/global/                              # cross-project
<agentDir>/cc-memory/projects/<sanitized-root>-<hash8>/   # per project
```

`agentDir` comes from Pi (`getAgentDir()`), normally `~/.pi/agent`. A dedicated
`cc-memory` subtree keeps this plugin from writing into an existing
`~/.pi/agent/memory` installation. Override the exact root with
`PI_CC_MEMORY_DIR` (absolute path or `~/...`).

```text
<store>/
├── MEMORY.md      index: one line per topic, navigation only
└── *.md           topic files with name/description/type frontmatter
```

Project identity is the canonical Git working tree (linked worktrees map to the
main repository). The slug is readable text plus an 8-character hash of the
resolved path, so two different paths cannot collide after sanitization.

## Routing (scope, not type)

```text
write  -> scope = tool input ?? PI_CC_MEMORY_DEFAULT_SCOPE ?? "project"
       -> global disabled and scope=global  => explicit error, no fallback
       -> type/scope mismatch               => warning on the result, write lands
read   -> explicit scope, else project first then global (resolved scope returned)
forget -> same resolution; reports when the path still exists in the other store
list   -> both stores, newest first, each row labelled with its scope
search -> project rows first, then global rows, labelled
index  -> one store when scoped, otherwise both sections
```

`global` is injected before `project`, and recall manifests qualify every path as
`scope:path` so a fact is never attributed to the wrong tier.

## Write path

```text
memory tool (action=write)
  -> validate title/type/description/body
  -> assertSafeTopicPath
  -> reject symlinks and escapes
  -> serialize frontmatter
  -> enforce topic byte budget
  -> [keyed mutex per store]
       atomic topic write (temp + rename)
       read index -> replace or append entry -> truncate -> atomic index write
  -> report created / indexUpdated / warnings
```

The index update never fabricates success: if it fails after the topic write, the
tool result contains a warning and `indexUpdated: false`.

## Read path

```text
session_start        -> resolve identity, create store dir, show topic count
before_agent_start   -> policy section (always)
                     -> index section (when recall is off)
                     -> recall message (when PI_CC_MEMORY_RECALL=1)
memory tool          -> status / list / read / write / forget / index / search
/memory              -> human status summary
session_shutdown     -> drop cached session state
```

Recall is off by default. When enabled, the index is not injected; instead up to
five topics are selected from a frontmatter manifest by the session model and
attached to the run as a hidden custom message. Selection is bounded by a
timeout, a per-file byte cap and a per-session byte budget derived from earlier
recall messages on the active branch. Failures degrade to "no recall".

## Known gaps (tracked by milestones)

| Gap | Milestone |
| --- | --- |
| Background extraction of durable facts | M3 |
| Cross-session consolidation / prune | M3 |
| Session memory / compaction integration | M2 |
| Cross-process store locking (only in-process mutex) | M2 hardening |
| Ranking beyond substring search and model selection | M3 |
| Settings-file configuration (env vars only) | M2 |
| Forget tombstones / recovery | M2 |
| Agent-scoped and team-scoped stores | post-M3 |
| Migration of existing Claude or pi-memory data | post-M3, explicit opt-in |
| Per-scope recall budgets (currently one shared budget) | M3 if evidence requires |

## Deliberate differences from the reference implementation

- Index budgets count real UTF-8 bytes, not UTF-16 string length.
- Recall does not skip requests merely because they contain no whitespace
  (CJK sentences have none).
- Project slugs always carry a hash, so sanitization cannot merge two projects.
- Writes report index failures instead of silently advancing.
- Core logic has no Pi imports and no Anthropic SDK dependency.
- The store root is namespaced under `cc-memory/`, so the plugin never adopts or
  overwrites an existing memory installation by accident.
- Scope is explicit. The reference implementation has one project store; this
  plugin adds a global tier without inferring scope from the memory type.
- Disabling global memory is a hard removal: no silent fallback to project.
