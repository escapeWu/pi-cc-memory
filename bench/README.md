# Benchmarks

Measurement, not pass/fail. `npm test` answers "is the behaviour correct"; these
answer "how good is it, what does it cost, and where does it degrade". Everything
uses synthetic data in a temp directory and never touches `~/.pi/agent` or
`~/.claude`.

How to run, compare and debug: see the project skill
[`.agents/skills/memory-benchmark/`](../.agents/skills/memory-benchmark/SKILL.md).
This file only defines what is measured.

| Layer | Entry | Model | What it answers |
| --- | --- | --- | --- |
| L1 | `bench/l1.ts` | no | store cost, prompt size and reach as topic count grows |
| L2 | `bench/l2.ts` | optional | does recall return the right topics, and nothing for unrelated prompts |

Results are written to `bench/results/*.json` (git-ignored) with commit, dirty
flag, Node version and every parameter.

## L1 — micro-benchmarks

Per topic count, warm cache, p50/p95:

| Metric | Meaning |
| --- | --- |
| `list_headers_*` | `listHeaders(maxCandidates)`; reads every topic head before sorting |
| `recall_no_select_*` | full `recall()` with a selector that returns nothing = per-turn store cost |
| `recall_top5_*` | same plus reading five topics |
| `search_miss_*` | `memory search` worst case |
| `upsert_*` | real locked write at that index size |
| `manifest_tokens_est` | what the selector model receives (bytes/4) |
| `window_share` | share of topics recall and search can reach (newest `maxCandidates`) |
| `index_visible_share` | share of index lines that survive the injection budget |
| `prompt_tokens_index_mode_est` / `..._recall_mode_max_est` | per-turn system-prompt cost of the two modes |
| contention rows | real multi-process upserts: ops/s, p50/p95 per op, failures |

## L2 — recall quality

The production `recall()` runs over a labelled corpus; a selector only has to
implement `MemorySelector`.

| Selector | Role |
| --- | --- |
| `none` | floor |
| `oracle` | returns gold topics that are inside the candidate window; the ceiling for any selector |
| `lexical` | IDF token overlap on name/description/path; cheap non-LLM comparison |
| `substring` | production `search` semantics with the whole prompt as needle (lower bound) |
| `llm` | production `createPiSelector` against a real model |

**Corpus.** A topic is a (domain, facet, subject) triple: 1440 distinct topics,
descriptions randomly English/Chinese, ages spread over 180 days, about 14% in the
global store. Queries paraphrase the same triple with different wording, so a hit
needs semantics. Kinds: `positive` (1 gold), `multi` (2 gold), `near-miss` (target
absent, close neighbours present; should select nothing), `off-topic` (should select
nothing). `hard` means at least two stored topics share two of the three attributes
with the target.

**Two kinds of miss.** `cover` is the share of gold topics inside the newest
`maxCandidates` topics; a gold topic outside it cannot be found by any selector.
`recall` counts those misses; `in-win` (recall inside the window) isolates the
selector. Past `maxCandidates` topics, `cover` — not selector quality — is the limit.

**Metrics.** `recall`: mean share of gold topics returned. `hit`: queries with at
least one gold topic returned. `prec`: over queries that returned anything.
`FR(neg)`: share of negative queries that returned any memory. `degr`: share of
model calls that timed out, errored, hit the token limit, or did not return
`{"files":[...]}`. `flip`: queries whose selection differed between repeats.
`±95%`: normal-approximation interval across queries.

**Limits.** Labels come from construction; a selector can legitimately pick a
semantically close neighbour and be scored wrong, so compare selectors against each
other instead of reading absolute numbers. Queries are templates, not real user
prompts. Live results depend on provider, model version and load. Timings are
warm-cache wall time and only comparable on the same machine.
