---
name: memory-benchmark
description: Run, compare and debug the pi-cc-memory benchmarks (bench/ L1 store cost and L2 recall quality). Use when changing recall, the selector, indexing, locking or model-call code and you need before/after numbers; when asked "how well does recall work", "does it scale", "did this change regress recall"; when a live selector run shows degraded calls, false recalls or flaky results; or when adding a selector, metric or corpus slice.
---

# memory-benchmark

Measurement tooling for pi-cc-memory. Definitions of every metric live in
`bench/README.md`; this skill is the procedure. Synthetic data only, temp
directories only: never point it at `~/.pi/agent` or `~/.claude`.

## Setup

`npm install --include=dev` (this machine omits dev dependencies globally; without
them `tsc` fails on `proper-lockfile` types). Scripts run on Node's native
TypeScript support; there is no build step.

## Choose the layer

| Question | Run |
| --- | --- |
| How does cost or prompt size grow with topic count? Is anything unreachable? | `npm run bench:l1` |
| Does recall find the right topics? How does a cheap baseline compare? | `npm run bench:l2` (offline, no network) |
| How good is the real selector model? | `npm run bench:live` or the explicit command below |

Never use L2 offline numbers as model quality: `oracle` and `lexical` are
references, not the selector.

## Commands

```bash
npm run bench:l1                                   # sizes 50,200,1000,5000
node bench/l1.ts --sizes 1000 --contention 1,4,8   # add multi-process write contention
node bench/l2.ts --sizes 20,100,400 --slices       # offline selectors + per-slice table
node bench/l2.ts --selectors oracle,lexical,llm --model provider/id \
  --sizes 100 --repeats 3 --concurrency 4 --timeout-ms 30000 --out /tmp/after.json
node bench/compare.ts /tmp/before.json /tmp/after.json --metric recall --metric degraded_rate
```

Flags worth knowing: `--seed` (corpus), `--positives/--multi/--near-miss/--off-topic`
(query counts, auto-trimmed to fit the store size), `--zh` (Chinese share),
`--max-candidates/--max-files` (override production limits to probe the window).

## Live runs (network)

- Opt in explicitly with `--model provider/id` or `PI_CC_MEMORY_LIVE_MODEL`. It
  sends synthetic topics and prompts to that model's provider; state this before
  running when the user has not already asked for a live run.
- Cost is roughly `queries x repeats` calls of ~4k tokens each at 100 topics.
  Start with `--sizes 20` for a smoke run.
- `--repeats 3` or more and `--positives 60` before believing a difference under
  about 5 points; check `±95%` and `flip` first.
- Use `--concurrency 4` for speed; latency under concurrency is not single-call
  latency. Compare latency only between runs with the same concurrency.

## Before/after comparison recipe

1. On the baseline commit run the exact command with `--out /tmp/before.json`.
2. Apply the change, rerun the same command (same seed, sizes, repeats, model,
   concurrency) with `--out /tmp/after.json`.
3. `node bench/compare.ts /tmp/before.json /tmp/after.json --min-change 0`.
   Rows are matched by label, so differing parameters silently drop rows.
4. Read slices, not only the `all` row: a gain on `hard` or `cross-lang` can hide
   a loss on `near-miss` false recall.
5. Report n for small slices; `near-miss` has about 8 queries, so one query is
   12 points.

## Reading results

- `recall` low but `in-win` high: the window is the limit (more than
  `maxCandidates` topics), not the selector. `cover` is the ceiling.
- `degr` above a few percent: calls are failing before scoring; fix that first
  (see debugging).
- `FR(neg)` on `off-topic` should be 0. `near-miss` false recall is a softer
  signal because the close neighbours are semantically defensible answers.
- `flip` high with repeats: selection is unstable; averages hide it.
- L1 timings are warm-cache wall time, comparable on one machine only; tokens are
  bytes/4 estimates.

## Debugging recipes

**High `degr`.** The harness counts a call as degraded on timeout, provider
error, any stop reason other than `stop`, or output without `{"files":[...]}`.
Classify real responses with a throwaway script (delete it afterwards):

```ts
// bench/_dbg.ts  (run: node bench/_dbg.ts)
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
const reg = new ModelRegistry(await ModelRuntime.create());
const model = reg.find("provider", "id")!;
const r = await reg.streamSimple(model, ctx, { maxTokens: 2048, reasoning: "minimal" }).result();
console.log(r.stopReason, r.content.map((b) => b.type), r.usage.output);
```

`stopReason: "length"` with only `thinking` content means a reasoning model spent
the whole output budget on thinking. The production defaults are in
`src/adapters/pi-model.ts` (`DEFAULT_MAX_TOKENS`, `reasoning: "minimal"`).

**Unexpected recall of exactly 0.** Check the selector is not `substring`: it
uses the whole prompt as one needle and finds nothing by design.

**Rows missing from compare.** Parameters differ between the two files; compare
the `params` blocks.

**Fixture or harness doubts.** `node --test test/bench.test.ts` checks corpus
ground truth and harness invariants; run it before trusting a surprising number.

## Extending

- New selector: add a kind in `bench/lib/selectors.ts` (and `OFFLINE_KINDS` if it
  needs no network). It must have the production `MemorySelector` shape so it runs
  through the real `recall()`.
- New metric: add it in `score()` and `sliceRow()` in `bench/lib/recall-eval.ts`;
  `compare.ts` picks up numeric metrics automatically.
- New corpus slice: label it in `bench/lib/corpus.ts` and add a `SLICES` entry.
- Keep `src/` free of imports from `bench/`; extend `test/bench.test.ts` for any
  new ground-truth rule.
