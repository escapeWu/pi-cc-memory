/**
 * L1: deterministic micro-benchmarks. No model, no network. Measures how the
 * store-side cost of memory grows with the number of topics, what the model is
 * handed per turn, and how much of the store each access path can even see.
 *
 * Timings are warm-cache wall time on the local filesystem (one warm-up run
 * discarded); compare runs on the same machine only.
 */
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { byteLength } from "../../src/core/format.ts";
import { buildMemoryPolicy } from "../../src/core/policy.ts";
import { recall, recallKey, searchStore } from "../../src/core/recall.ts";
import { generateCorpus } from "./corpus.ts";
import { type Fixture, materialize } from "./fixture.ts";
import { type BenchResult, format, printTable, type Row } from "./report.ts";
import { mean, percentile, sample } from "./stats.ts";

export interface MicroOptions {
	sizes: number[];
	iterations: number;
	/** Concurrent writer process counts; empty skips the contention test. */
	contention: number[];
	contentionOps: number;
	seed: number;
	log?: (message: string) => void;
}

const TOKEN_BYTES = 4; // rough bytes/token heuristic; CJK text is denser, so treat as an estimate.
const ENTRY_LINE = /^- \[/;

async function measureSize(size: number, options: MicroOptions): Promise<Row> {
	const corpus = generateCorpus({ seed: options.seed, size, positives: 0, multi: 0, nearMiss: 0, offTopic: 0, globalEnabled: false });
	const fixture = await materialize(corpus);
	try {
		return await measureFixture(size, fixture, options);
	} finally {
		await fixture.cleanup();
	}
}

async function measureFixture(size: number, fixture: Fixture, options: MicroOptions): Promise<Row> {
	const { recall: config } = fixture.config;
	const project = fixture.router.project;
	const limits = {
		maxCandidates: config.maxCandidates,
		maxFiles: config.maxFiles,
		maxFileBytes: config.maxFileBytes,
		maxSessionBytes: config.maxSessionBytes,
	};
	const run = (fn: () => Promise<unknown>) => sample(fn, options.iterations);
	const probe = "benchmark probe query";

	const listing = await run(() => project.listHeaders(limits.maxCandidates));
	const recallNone = await run(() => recall(fixture.sources, probe, async () => [], limits));
	let manifest = "";
	const recallTop = await run(() =>
		recall(
			fixture.sources,
			probe,
			async (input) => {
				manifest = input.manifest;
				return input.candidates.slice(0, limits.maxFiles).map((c) => recallKey(c.scope, c.path));
			},
			limits,
		),
	);
	const searchMiss = await run(() => searchStore(project, "no-such-needle-zzz", { limit: 10, candidates: limits.maxCandidates }));

	// What each context-injection mode hands the model every turn.
	const fullIndex = await readFile(project.indexPath, "utf8");
	const injected = await project.readIndex();
	const totalEntries = fullIndex.split("\n").filter((line) => ENTRY_LINE.test(line)).length;
	const visibleEntries = injected.split("\n").filter((line) => ENTRY_LINE.test(line)).length;
	const policyBase = { projectRoot: project.root };
	const policyWithIndex = byteLength(buildMemoryPolicy({ ...policyBase, includeIndex: true, projectIndex: injected }));
	const policyOnly = byteLength(buildMemoryPolicy({ ...policyBase, includeIndex: false }));
	const recallCeiling = policyOnly + limits.maxFiles * limits.maxFileBytes;

	// Mutates the fixture, so it runs last.
	const first = [...fixture.topics.values()][0];
	if (!first) throw new Error("empty fixture");
	const upsert = await run(() =>
		project.upsert({ path: first.path, title: first.title, type: first.type, description: first.description, body: first.body }),
	);

	return {
		label: `size=${size}`,
		metrics: {
			size,
			list_headers_p50_ms: percentile(listing, 50),
			list_headers_p95_ms: percentile(listing, 95),
			recall_no_select_p50_ms: percentile(recallNone, 50),
			recall_no_select_p95_ms: percentile(recallNone, 95),
			recall_top5_p50_ms: percentile(recallTop, 50),
			recall_top5_p95_ms: percentile(recallTop, 95),
			search_miss_p50_ms: percentile(searchMiss, 50),
			upsert_p50_ms: percentile(upsert, 50),
			upsert_p95_ms: percentile(upsert, 95),
			manifest_bytes: byteLength(manifest),
			manifest_tokens_est: Math.round(byteLength(manifest) / TOKEN_BYTES),
			window_share: Math.min(1, limits.maxCandidates / size),
			index_entries: totalEntries,
			index_visible_share: totalEntries ? visibleEntries / totalEntries : 1,
			index_injected_bytes: byteLength(injected),
			prompt_bytes_index_mode: policyWithIndex,
			prompt_bytes_recall_mode_max: recallCeiling,
			prompt_tokens_index_mode_est: Math.round(policyWithIndex / TOKEN_BYTES),
			prompt_tokens_recall_mode_max_est: Math.round(recallCeiling / TOKEN_BYTES),
		},
	};
}

async function measureContention(workers: number, options: MicroOptions): Promise<Row> {
	const corpus = generateCorpus({ seed: options.seed, size: 200, positives: 0, multi: 0, nearMiss: 0, offTopic: 0, globalEnabled: false });
	const fixture = await materialize(corpus);
	try {
		const script = fileURLToPath(new URL("../fixtures/writer.ts", import.meta.url));
		const children = Array.from({ length: workers }, (_, id) => {
			const child = fork(script, [fixture.router.project.root, String(options.contentionOps), String(id)], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			let errors = "";
			child.stderr?.on("data", (chunk) => {
				errors += String(chunk);
			});
			const done = new Promise<{ latencies: number[]; failures: number }>((resolve, reject) => {
				child.on("message", (message) => {
					if (message !== "ready") resolve(message as { latencies: number[]; failures: number });
				});
				child.once("exit", (code) => {
					if (code !== 0) reject(new Error(`writer failed (${code}): ${errors}`));
				});
			});
			void done.catch(() => {});
			return { child, done };
		});
		await Promise.all(children.map(({ child }) => once(child, "message")));
		const start = performance.now();
		for (const { child } of children) child.send("go");
		const results = await Promise.all(children.map(({ done }) => done));
		const wallMs = performance.now() - start;
		const latencies = results.flatMap((r) => r.latencies);
		return {
			label: `contention writers=${workers}`,
			metrics: {
				writers: workers,
				ops: latencies.length,
				failures: results.reduce((sum, r) => sum + r.failures, 0),
				throughput_ops_s: latencies.length / (wallMs / 1000),
				op_p50_ms: percentile(latencies, 50),
				op_p95_ms: percentile(latencies, 95),
				op_mean_ms: mean(latencies),
			},
		};
	} finally {
		await fixture.cleanup();
	}
}

export async function runMicro(options: MicroOptions, result: BenchResult): Promise<void> {
	const log = options.log ?? (() => {});
	for (const size of options.sizes) {
		log(`L1 size=${size}`);
		result.rows.push(await measureSize(size, options));
	}
	for (const workers of options.contention) {
		log(`L1 contention writers=${workers}`);
		result.rows.push(await measureContention(workers, options));
	}
}

const metric = (row: Row, key: string, digits = 1) => format(row.metrics[key], digits);

export function printMicroSummary(rows: readonly Row[]): void {
	const sizes = rows.filter((r) => r.label.startsWith("size="));
	if (sizes.length) {
		console.log("\nL1 store cost per turn / operation (ms, warm cache)");
		printTable(
			["topics", "list p50", "list p95", "recall p50", "+read5 p50", "search p50", "upsert p50", "upsert p95"],
			sizes.map((r) => [
				metric(r, "size", 0),
				metric(r, "list_headers_p50_ms"),
				metric(r, "list_headers_p95_ms"),
				metric(r, "recall_no_select_p50_ms"),
				metric(r, "recall_top5_p50_ms"),
				metric(r, "search_miss_p50_ms"),
				metric(r, "upsert_p50_ms"),
				metric(r, "upsert_p95_ms"),
			]),
		);
		console.log("\nL1 what the model is handed, and what each path can see");
		printTable(
			["topics", "manifest tok", "window", "idx entries", "idx visible", "prompt tok (index)", "prompt tok (recall max)"],
			sizes.map((r) => [
				metric(r, "size", 0),
				metric(r, "manifest_tokens_est", 0),
				`${format((r.metrics.window_share as number) * 100, 0)}%`,
				metric(r, "index_entries", 0),
				`${format((r.metrics.index_visible_share as number) * 100, 0)}%`,
				metric(r, "prompt_tokens_index_mode_est", 0),
				metric(r, "prompt_tokens_recall_mode_max_est", 0),
			]),
		);
		console.log(
			"\nwindow = share of topics recall() and search can reach (newest maxCandidates); idx visible = share of index lines surviving the injection budget.\nTokens are bytes/4 estimates.",
		);
	}
	const contention = rows.filter((r) => r.label.startsWith("contention"));
	if (contention.length) {
		console.log("\nL1 cross-process write contention (real upserts, shared store)");
		printTable(
			["writers", "ops", "fail", "ops/s", "p50 ms", "p95 ms"],
			contention.map((r) => [
				metric(r, "writers", 0),
				metric(r, "ops", 0),
				metric(r, "failures", 0),
				metric(r, "throughput_ops_s"),
				metric(r, "op_p50_ms"),
				metric(r, "op_p95_ms"),
			]),
		);
	}
}
