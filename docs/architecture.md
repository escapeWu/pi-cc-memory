# Architecture

`pi-cc-memory` is a Pi coding-agent extension. M1 is a working project memory
store plus explicit read/write tools. Background extraction (M3) is not wired.

## Layers

```text
src/extension.ts          Pi lifecycle wiring, tool, /memory command
src/config.ts             validated env/global/project settings, resolved per call
src/core/                 host-neutral logic (no Pi imports)
  types.ts                memory types, records, results
  format.ts               Markdown codec, index, budgets, path validation
  identity.ts             canonical Git root -> project slug
  scopes.ts               project/global scope, type-vs-scope advisory
  policy.ts               model-facing maintenance rules
  store.ts                single owner of MEMORY.md, topics and recovery transactions
  recovery.ts             versioned snapshot codec and recovery-id validation
  router.ts               routes operations to project and/or global store
  recall.ts               candidate scan, injected selector, budget, search
src/adapters/             host I/O (Pi + filesystem)
  filesystem.ts           atomic writes, bounded reads, keyed mutex
  store-lock.ts           canonical cross-process lock, heartbeat and bounded wait
  settings.ts             read the ccMemory namespace without rewriting host files
  pi-model.ts             bounded registry calls for recall and session notes
  pi-session.ts           branch-scoped state (recall usage, M3 cursor)
  session-note.ts         continuity snapshot and native compaction input
src/services/             M3 placeholders, never called by M1 wiring
  extraction.ts
  consolidation.ts
```

The entrypoint composes the router, config and Pi adapters. `core/store.ts`
coordinates filesystem/lock adapters; the other core modules hold formats and
memory decisions. `core/` never imports `@earendil-works/*`. Model and session
adapters own all Pi interaction.

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
├── .recovery/     immutable JSON snapshots, excluded from recall/search
├── .store.lock/   cross-process lock directory while a writer owns the store
└── *.md           topic files with name/description/type frontmatter
```

Project identity is the physical canonical Git working tree (linked worktrees
map to the main repository). Filesystem aliases such as macOS `/var` and
`/private/var` resolve to the same identity ([Issue #1](https://github.com/escapeWu/pi-cc-memory/issues/1)).
The slug is readable text plus an 8-character hash of the resolved path, so two
different paths cannot collide after sanitization.

## Routing (scope, not type)

```text
write  -> scope = tool input ?? PI_CC_MEMORY_DEFAULT_SCOPE ?? "project"
       -> global disabled and scope=global  => explicit error, no fallback
       -> type/scope mismatch               => warning on the result, write lands
read   -> explicit scope, else project first then global (resolved scope returned)
forget -> same resolution; snapshot first, report recoveryId and any other-store copy
restore -> explicit scope or configured default; recover only the matching snapshot
list   -> select scope when given, then newest-first and limit
search -> select scope before applying the result limit; otherwise project first
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
  -> [canonical store lock shared by processes]
       atomic topic write (temp + rename)
       read complete index -> replace or append entry -> atomic index write
  -> bounded index view at read/injection time (complete entries stay on disk)
  -> report created / indexUpdated / warnings
```

The index update never fabricates success: if it fails after the topic write, the
tool result contains a warning and `indexUpdated: false`.
Topic and ancestor symlinks, nested hidden paths, and symlinked indexes are
rejected; this includes a new topic whose leaf does not exist yet. Index views
include their truncation warning within the configured line/byte limits
([Issue #2](https://github.com/escapeWu/pi-cc-memory/issues/2)).

## Read path

```text
session_start        -> resolve identity, create store dir, show topic count
before_agent_start   -> policy section (always)
                     -> index section (when recall is off)
                     -> recall message (when PI_CC_MEMORY_RECALL=1)
memory tool          -> status / list / read / write / forget / restore / index / search
session_before_compact -> bounded session note -> native compaction input
/memory              -> human status summary
session_shutdown     -> drop cached session state
```

Recall is off by default. When enabled, the index is not injected; instead up to
five topics are selected from a frontmatter manifest by the session model and
attached to the run as a hidden custom message. Selection is bounded by a
timeout, a per-file byte cap and a current-context byte budget. The wrapper,
separators and truncation notice all count against that budget. Selection has a
hard deadline even if a provider ignores cancellation; failures degrade to
"no recall" ([Issue #5](https://github.com/escapeWu/pi-cc-memory/issues/5)).

`readRecallUsage()` reads `sessionManager.buildSessionProjection().messages`,
not the raw branch. Native compaction only releases budget for recalled messages
that leave effective context; kept messages remain counted. Tree navigation,
resume, fork and context edits therefore use the host's authoritative state,
without a second branch cache or a custom compaction hook
([Issue #4](https://github.com/escapeWu/pi-cc-memory/issues/4)).

## Mutation locking and recovery

`withStoreLock()` wraps every write, forget, restore and rebuild operation using
`proper-lockfile` plus in-process serialization. Writers use a fixed 3-second
heartbeat and 10-second stale threshold, and wait up to about 15 seconds.
Canonical real paths give aliases one lock. The scope is local filesystems;
all cooperating writers must keep the same heartbeat/stale policy
([Issue #8](https://github.com/escapeWu/pi-cc-memory/issues/8)).

Forget writes a UUID receipt containing exact topic bytes, content hash and index
pointer before deletion. Restore validates the receipt, checks for conflicting
content, then writes topic and index under the same lock. Repeating restore is
idempotent. Known index-write failures roll back the topic change and report an
error; receipts remain available. Atomic renames and receipts do not provide a
database-style commit across a process or machine crash
([Issue #7](https://github.com/escapeWu/pi-cc-memory/issues/7)).

## Session continuity and settings

`session_before_compact` derives a bounded Markdown note from the latest active
context. It persists `cc-memory/session-note` as a custom entry outside ordinary
model context and merges the note into the native preparation's `previousSummary`.
Pi 1.2.0 does not support overriding `customInstructions` in this hook. The adapter
keeps native messages, cut point, file operations and user instructions intact;
invalid output, model error or timeout leaves native compaction unchanged.
`readSessionNote()` reads the active branch instead of caching state across tree
navigation or session replacement
([Issue #6](https://github.com/escapeWu/pi-cc-memory/issues/6)).

`loadConfig()` reads only `ccMemory` from Pi's global and cwd project settings on
every call. It validates each source and applies per-field env/project/global/default
precedence. A changed effective configuration rebuilds the router; unchanged
configuration reuses it. Settings cannot set store paths, and errors identify the
source file/field without including its contents
([Issue #9](https://github.com/escapeWu/pi-cc-memory/issues/9)).

## Known gaps (tracked by milestones)

| Gap | Milestone |
| --- | --- |
| Background extraction of durable facts | M3 |
| Cross-session consolidation / prune | M3 |
| Ranking beyond substring search and model selection | M3 |
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
