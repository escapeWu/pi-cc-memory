# Milestones

Three milestones, each independently useful. A milestone is done only when its
exit criteria are verified in a real Pi session, not merely merged.

Status: **M1 code complete, pre-release**. M2/M3 are planned.

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
| [#1](https://github.com/escapeWu/pi-cc-memory/issues/1) M1-1 项目身份与 store 目录解析 | canonical root, slug, paths | implemented, tested |
| [#2](https://github.com/escapeWu/pi-cc-memory/issues/2) M1-2 主题文件与索引 codec | format, budgets, validation | implemented, tested |
| [#3](https://github.com/escapeWu/pi-cc-memory/issues/3) M1-3 维护规则注入 | policy prompt section | implemented, live check pending |
| [#4](https://github.com/escapeWu/pi-cc-memory/issues/4) M1-4 索引加载与生命周期 | load, inject, lifecycle | implemented, compaction/branch check pending |
| [#5](https://github.com/escapeWu/pi-cc-memory/issues/5) M1-5 自动召回 | selection, budgets, degradation | implemented, live model check pending |

M1 stays open until a real Pi session verifies the unchecked criteria in #3–#5.

---

## M2 — 增强：Session memory 与存储加固

**Goal:** long sessions keep continuity across compaction, and memory writes are
safe under concurrent processes.

Pi already owns compaction. M2 extends it rather than replacing it.

**Scope**

1. **Session note** — derive a compact "current state / open threads / decisions"
   note from the active branch, stored outside the persistent project memory.
2. **Compaction cooperation** — pass the note as focused `customInstructions` in
   `session_before_compact`, or supply an extension compaction only if the note is
   provably better than the native summary. Fall back to native compaction.
3. **Post-compact refresh** — after `session_compact` and `session_tree`, recompute
   the injected index/recall budget so stale context is never reused.
4. **Forget safety** — tombstone or recovery record so a mistaken `forget` can be
   restored; keep the index consistent.
5. **Cross-process locking** — replace the in-process mutex with a lock file that
   also survives multiple Pi processes on the same store.
6. **Settings surface** — `settings.json` (global + project) for recall, budgets
   and model, with env vars as overrides.

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
lock, [#9](https://github.com/escapeWu/pi-cc-memory/issues/9) settings surface.

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
- Optional global user store alongside per-project memory.
