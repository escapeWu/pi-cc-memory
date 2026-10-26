# Milestones

Three milestones, each independently useful. A milestone is done only when its
exit criteria are verified in a real Pi session, not merely merged.

Status: **M1 verified on Pi 1.2.0 SDK sessions, including real model writes,
pre-answer recall, native compaction, resume and fork**. **M2 verification passed**
with independent processes, actual SDK sessions and real-model recovery/continuity.
M3 is planned.

---

## M1 — 最小可运行

**Goal:** the next session can actually use what this session learned, without
background agents.

**Scope**

| Capability | Implementation |
| --- | --- |
| Auto memory | Project-scoped topic files, `MEMORY.md` index, maintenance policy |
| Storage | Canonical Git root identity, atomic writes, in-process serialization |
| Injection | Policy section always; index section when recall is off |
| Tools | `memory` tool: status/list/read/write/forget/index/search |
| Two stores | Explicit `scope=project|global`; global tier is disableable |
| Lifecycle | `session_start`, `before_agent_start`, `session_shutdown` |
| 自动召回 | Frontmatter manifest → model selection → bounded hidden message |

**Exit criteria**

1. A fresh session injects the policy and the current index.
2. `write` creates a topic file plus exactly one index line; a later session
   reads that topic without any manual step.
3. `write` to the same path updates the file and replaces its index hook instead
   of adding a duplicate line.
4. `forget` removes both the topic and its index entry.
5. Two linked worktrees of one repository resolve to the same store; two
   unrelated repositories do not.
5b. With global enabled, `scope=global` writes land in the global store and are
   visible from another project; with `PI_CC_MEMORY_GLOBAL=0`, they fail loudly
   and the global index is not injected.
6. With recall on, the index is not injected and at most five selected topics are
   attached before the first model answer.
7. Selector timeout, model error or malformed JSON degrade to no recall; the turn
   still completes.
8. Traversal, absolute paths, non-Markdown targets and symlinked topics are
   rejected.
9. `tsc --noEmit` is clean and the core tests pass.

**Explicitly out of scope:** background extraction, consolidation, session
summaries, team sync, agent-scoped stores, settings-file UI, data migration.

**Issues**

| Issue | Scope | Local status |
| --- | --- | --- |
| [#1](https://github.com/escapeWu/pi-cc-memory/issues/1) M1-1 项目身份与 store 目录解析 | canonical root, slug, paths | verified with actual Git worktree + SDK sessions |
| [#2](https://github.com/escapeWu/pi-cc-memory/issues/2) M1-2 主题文件与索引 codec | format, budgets, validation | verified, including ancestor symlink rejection |
| [#3](https://github.com/escapeWu/pi-cc-memory/issues/3) M1-3 维护规则注入 | policy prompt section | single section verified in actual model transcript |
| [#4](https://github.com/escapeWu/pi-cc-memory/issues/4) M1-4 索引加载与生命周期 | load, inject, lifecycle | SDK compaction/tree/resume/fork verified |
| [#5](https://github.com/escapeWu/pi-cc-memory/issues/5) M1-5 自动召回 | selection, budgets, degradation | real selector and pre-answer recall verified |

`test/integration/runtime.test.ts` loads the extension through Pi's actual
resource loader and runner. It checks the SDK lifecycle with a deterministic
provider. `scripts/verify-live.ts` separately checks real model behavior with
synthetic topics; the prompt assertions use the finalized session transcript,
not the idle `session.systemPrompt` getter ([PR #14](https://github.com/escapeWu/pi-cc-memory/pull/14)).
This evidence covers the SDK host; installing beside other memory extensions or
interactive terminal rendering has not been validated.

---

## M2 — 增强：Session memory 与存储加固

**Goal:** long sessions keep continuity across compaction, and memory writes are
safe under concurrent processes.

Pi already owns compaction. M2 extends it rather than replacing it.

**Scope**

1. **Session note** — derive a compact "current state / open threads / decisions"
   note from the active branch, stored outside the persistent project memory.
2. **Compaction cooperation** — generate one bounded note in
   `session_before_compact`. Pi 1.2.0 has no `customInstructions` override for
   that event, so the note augments native `preparation.previousSummary`.
   The plugin never replaces the native compactor; generation failure falls back.
3. **Branch state** — `/memory note` reads the latest snapshot on the active
   branch. Tree navigation, resume and fork reconstruct state from Pi entries;
   indexes and recall usage continue to refresh from effective context each run.
4. **Forget safety** — save exact content in `.recovery/` before deletion;
   `memory restore` accepts the stable recovery id and original scope, and refuses
   to overwrite newer content.
5. **Cross-process locking** — all store mutations use `proper-lockfile` with
   a fixed heartbeat/stale policy and bounded acquisition wait.
6. **Settings surface** — per-field `env > project > global > default` resolution
   in Pi's `ccMemory` namespace. Reload on each call, strict validation, and no
   store-path overrides from project settings.

**Exit criteria**

1. A session that crosses the compaction threshold retains its open threads and
   does not lose or duplicate memory entries.
2. A forgotten memory can be restored from a recorded recovery id.
3. Two Pi processes writing different topics to the same store keep both index
   entries.
4. Configuration from settings and env is resolved with a documented precedence.
5. All M1 criteria still pass.

**Issues:** [#6](https://github.com/escapeWu/pi-cc-memory/issues/6) session
note + compaction, [#7](https://github.com/escapeWu/pi-cc-memory/issues/7) forget
recovery, [#8](https://github.com/escapeWu/pi-cc-memory/issues/8) cross-process
lock, [#9](https://github.com/escapeWu/pi-cc-memory/issues/9) settings surface,
[#13](https://github.com/escapeWu/pi-cc-memory/issues/13) global user store.

`test/m2-store.test.ts` uses actual Node processes for lock contention, crashed
lock recovery and cross-process restoration. `test/integration/m2.test.ts` checks
Pi's native compactor, branch notes, restore and config updates; `test/m2-config.test.ts`
checks precedence and invalid values. `npm run verify:m2` is the separate real-model
acceptance entrypoint and uses only temporary synthetic data. Real-model
acceptance confirmed exact recovery in a new session and preservation of the
unfinished ticket/decision after native compaction ([PR #15](https://github.com/escapeWu/pi-cc-memory/pull/15)).

**Explicitly out of scope:** automatic extraction of new facts, cross-session
consolidation, team sync.

---

## M3 — 增强：后台提炼与跨会话整合

**Goal:** the plugin maintains itself — new durable facts are captured after a
turn, and existing memories are merged and pruned over time.

**Scope**

1. **Extraction** — after `agent_before_settle` with a completed run, read the
   branch slice after a persisted cursor, ask a bounded model step to update
   topics, commit the cursor only after a verified store write.
2. **Single flight** — one extraction per session; newest pending context wins;
   one trailing run after the active one finishes.
3. **Consolidation** — time + session-count gate, store-level lock, merge into
   existing topics, fix contradictions, prune the index.
4. **Observability** — a visible "saved N memories" / "improved N files" message
   and a status line, without polluting model context.
5. **Ranking** — replace linear substring search with a bounded ranked index if
   evidence shows substring search is insufficient.

**Exit criteria**

1. A turn that establishes a new durable fact is captured without an explicit
   `write`, exactly once, and is visible in the index afterwards.
2. A failed extraction never advances the cursor and never reports "saved".
3. A memory the main agent already wrote in that turn is not duplicated by the
   background extractor.
4. Consolidation runs at most once per gate window, merges near-duplicates and
   removes contradicted facts.
5. Extraction and consolidation cannot corrupt the index under concurrent writes.
6. All M1/M2 criteria still pass.

---

**Issues:** [#10](https://github.com/escapeWu/pi-cc-memory/issues/10) background
extraction, [#11](https://github.com/escapeWu/pi-cc-memory/issues/11) auto dream,
[#12](https://github.com/escapeWu/pi-cc-memory/issues/12) ranking upgrade
(evidence-gated).

---

## Post-M3 (not scheduled)

- Agent-scoped stores (`user` / `project` / `local`) with explicit identity.
- Team/shared store with a documented sync contract (deletes included).
- Explicit, opt-in migration from `~/.claude/projects/*/memory` and existing
  `~/.pi/agent/memory` layouts.
