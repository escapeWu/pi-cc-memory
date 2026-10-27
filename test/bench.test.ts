/** Guards the benchmark harness itself: a wrong ground truth would make every score meaningless. */
import assert from "node:assert/strict";
import test from "node:test";
import { generateCorpus } from "../bench/lib/corpus.ts";
import { runMicro } from "../bench/lib/micro.ts";
import { runRecallEval } from "../bench/lib/recall-eval.ts";
import { newResult } from "../bench/lib/report.ts";
import { tokenize } from "../bench/lib/selectors.ts";

test("corpus is reproducible and ground truth is consistent", () => {
	const a = generateCorpus({ size: 120, seed: 7 });
	const b = generateCorpus({ size: 120, seed: 7 });
	assert.deepEqual(a, b);
	assert.notDeepEqual(a.queries, generateCorpus({ size: 120, seed: 8 }).queries);

	assert.equal(a.topics.length, 120);
	const keys = new Set(a.topics.map((t) => t.key));
	assert.equal(keys.size, a.topics.length, "topic keys are unique");
	assert.equal(new Set(a.topics.map((t) => t.ageDays)).size, a.topics.length, "ages are distinct so recency order is total");

	const kinds = new Set(a.queries.map((q) => q.kind));
	for (const kind of ["positive", "multi", "near-miss", "off-topic"]) assert.ok(kinds.has(kind as never), `missing ${kind} queries`);
	for (const q of a.queries) {
		if (q.kind === "positive") assert.equal(q.gold.length, 1);
		if (q.kind === "multi") assert.equal(q.gold.length, 2);
		if (q.kind === "near-miss" || q.kind === "off-topic") assert.deepEqual(q.gold, []);
		for (const key of q.gold) assert.ok(keys.has(key), `gold ${key} is not in the store`);
	}
	for (const q of a.queries.filter((x) => x.kind === "near-miss")) assert.ok(q.neighbors >= 2, "near-miss targets have close neighbours");
});

test("labelled queries cannot exceed the distinct topic space", () => {
	assert.throws(() => generateCorpus({ size: 5000 }), /distinct/);
	assert.equal(generateCorpus({ size: 1600, positives: 0, multi: 0, nearMiss: 0, offTopic: 0 }).topics.length, 1600);
});

test("tokenizer handles Latin and CJK", () => {
	assert.deepEqual(tokenize("The orders rollback!"), ["orders", "rollback"]);
	assert.deepEqual(tokenize("orders 回滚流程"), ["orders", "回滚", "滚流", "流程"]);
});

test("L2 harness: none scores 0, oracle reaches the window ceiling, lexical sits between", { timeout: 60000 }, async () => {
	const result = newResult("test", {});
	await runRecallEval(
		{
			sizes: [60],
			selectors: ["none", "oracle", "lexical", "substring"],
			corpus: { seed: 3 },
			repeats: 1,
			concurrency: 1,
			maxCandidates: 30,
		},
		result,
	);
	const row = (sel: string, slice = "all") => result.rows.find((r) => r.label === `size=60 sel=${sel} slice=${slice}`)?.metrics;
	const value = (sel: string, key: string, slice = "all") => {
		const found = row(sel, slice)?.[key];
		assert.equal(typeof found, "number", `${sel}.${slice}.${key}`);
		return found as number;
	};
	// Window of 30 over 60 topics: coverage is structural, not a selector property.
	const coverage = value("oracle", "coverage");
	assert.ok(coverage > 0 && coverage < 1, `coverage ${coverage} should reflect a truncated window`);
	assert.equal(value("none", "recall"), 0);
	assert.equal(value("none", "false_recall"), 0);
	assert.ok(Math.abs(value("oracle", "recall") - coverage) < 1e-9, "oracle recall equals window coverage");
	assert.equal(value("oracle", "recall_in_window"), 1);
	assert.equal(value("oracle", "false_recall"), 0);
	assert.equal(value("oracle", "precision"), 1);
	assert.ok(value("lexical", "recall") <= value("oracle", "recall"));
	assert.equal(value("lexical", "degraded_rate"), 0);
	assert.equal(value("substring", "recall"), 0, "whole-prompt substring needle finds nothing");
});

test("L1 harness produces finite measurements", { timeout: 60000 }, async () => {
	const result = newResult("test", {});
	await runMicro({ sizes: [40], iterations: 2, contention: [2], contentionOps: 4, seed: 1 }, result);
	const sizeRow = result.rows.find((r) => r.label === "size=40");
	assert.ok(sizeRow);
	for (const [key, metric] of Object.entries(sizeRow.metrics)) {
		assert.ok(typeof metric === "number" && Number.isFinite(metric), `${key} must be finite`);
	}
	assert.equal(sizeRow.metrics.window_share, 1);
	assert.equal(sizeRow.metrics.index_visible_share, 1);
	const contention = result.rows.find((r) => r.label === "contention writers=2");
	assert.equal(contention?.metrics.failures, 0);
	assert.equal(contention?.metrics.ops, 8);
});
