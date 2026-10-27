/**
 * L2: recall quality. Runs the production recall() over a labelled synthetic
 * corpus with interchangeable selectors and scores what it returns.
 *
 * Two kinds of miss are separated on purpose:
 * - window miss: the gold topic is not among the newest `maxCandidates`, so no
 *   selector could have found it (structural; the `oracle` row is the ceiling);
 * - selector miss: the gold topic was a candidate but was not selected.
 */
import { recall, recallKey } from "../../src/core/recall.ts";
import { type CorpusOptions, generateCorpus, type QuerySpec } from "./corpus.ts";
import { materialize } from "./fixture.ts";
import { liveFactory } from "./live.ts";
import { type BenchResult, format, pct, printTable, type Row } from "./report.ts";
import { NO_USAGE, offlineFactory, type SelectorFactory, type SelectorKind, type Usage } from "./selectors.ts";
import { ci95, mapPool, mean, percentile, timed } from "./stats.ts";

export interface EvalOptions {
	sizes: number[];
	selectors: SelectorKind[];
	corpus: Partial<CorpusOptions>;
	repeats: number;
	concurrency: number;
	maxCandidates?: number;
	maxFiles?: number;
	timeoutMs?: number;
	modelRef?: string;
	log?: (message: string) => void;
}

interface Run {
	selected: string[];
	ms: number;
	usage: Usage;
	skipped: string | undefined;
}
interface Score {
	query: QuerySpec;
	coverage: number;
	recall: number;
	hit: number;
	precision: number | undefined;
	inWindow: number | undefined;
	falseRecall: number;
	selectedCount: number;
	flip: number | undefined;
	degraded: number;
	input: number;
	output: number;
}

const intersect = (a: readonly string[], b: ReadonlySet<string>) => a.filter((x) => b.has(x));
const defined = (values: readonly (number | undefined)[]) => values.filter((v): v is number => v !== undefined);
const avgOrNull = (values: readonly (number | undefined)[]) => {
	const xs = defined(values);
	return xs.length ? mean(xs) : null;
};

function score(query: QuerySpec, window: ReadonlySet<string>, runs: readonly Run[]): Score {
	const gold = new Set(query.gold);
	const inWin = new Set(query.gold.filter((key) => window.has(key)));
	const perRun = runs.map((run) => {
		const hits = intersect(run.selected, gold).length;
		return {
			recall: gold.size ? hits / gold.size : 0,
			precision: run.selected.length ? hits / run.selected.length : undefined,
			inWindow: inWin.size ? intersect(run.selected, inWin).length / inWin.size : undefined,
			count: run.selected.length,
		};
	});
	const signature = (run: Run) => [...run.selected].sort().join("|");
	return {
		query,
		coverage: gold.size ? inWin.size / gold.size : 1,
		recall: mean(perRun.map((r) => r.recall)),
		hit: mean(perRun.map((r) => (r.recall > 0 ? 1 : 0))),
		precision: avgOrNull(perRun.map((r) => r.precision)) ?? undefined,
		inWindow: avgOrNull(perRun.map((r) => r.inWindow)) ?? undefined,
		falseRecall: mean(perRun.map((r) => (r.count > 0 ? 1 : 0))),
		selectedCount: mean(perRun.map((r) => r.count)),
		flip: runs.length > 1 ? (new Set(runs.map(signature)).size > 1 ? 1 : 0) : undefined,
		degraded: mean(runs.map((r) => (r.usage.degraded > 0 ? 1 : 0))),
		input: mean(runs.map((r) => r.usage.input)),
		output: mean(runs.map((r) => r.usage.output)),
	};
}

const isPositive = (s: Score) => s.query.kind === "positive" || s.query.kind === "multi";
const SLICES: { name: string; match: (s: Score) => boolean; negative?: boolean }[] = [
	{ name: "positive", match: isPositive },
	{ name: "single", match: (s) => s.query.kind === "positive" },
	{ name: "multi", match: (s) => s.query.kind === "multi" },
	{ name: "same-lang", match: (s) => isPositive(s) && s.query.sameLang === true },
	{ name: "cross-lang", match: (s) => isPositive(s) && s.query.sameLang === false },
	{ name: "easy", match: (s) => isPositive(s) && !s.query.hard },
	{ name: "hard", match: (s) => isPositive(s) && s.query.hard },
	{ name: "in-window", match: (s) => isPositive(s) && s.coverage === 1 },
	{ name: "out-window", match: (s) => isPositive(s) && s.coverage < 1 },
	{ name: "near-miss", match: (s) => s.query.kind === "near-miss", negative: true },
	{ name: "off-topic", match: (s) => s.query.kind === "off-topic", negative: true },
];

function sliceRow(size: number, sel: string, name: string, scores: readonly Score[], negative: boolean): Row {
	const metrics: Row["metrics"] = { size, sel, slice: name, n: scores.length };
	if (negative) {
		metrics.false_recall = mean(scores.map((s) => s.falseRecall));
		metrics.avg_selected = mean(scores.map((s) => s.selectedCount));
	} else {
		metrics.recall = mean(scores.map((s) => s.recall));
		metrics.recall_ci95 = ci95(scores.map((s) => s.recall));
		metrics.hit = mean(scores.map((s) => s.hit));
		metrics.precision = avgOrNull(scores.map((s) => s.precision));
		metrics.recall_in_window = avgOrNull(scores.map((s) => s.inWindow));
		metrics.coverage = mean(scores.map((s) => s.coverage));
		metrics.avg_selected = mean(scores.map((s) => s.selectedCount));
	}
	return { label: `size=${size} sel=${sel} slice=${name}`, metrics };
}

export async function runRecallEval(options: EvalOptions, result: BenchResult): Promise<void> {
	const log = options.log ?? (() => {});
	for (const size of options.sizes) {
		const corpus = generateCorpus({ ...options.corpus, size });
		const fixture = await materialize(corpus);
		try {
			const recallConfig = fixture.config.recall;
			const limits = {
				maxCandidates: options.maxCandidates ?? recallConfig.maxCandidates,
				maxFiles: options.maxFiles ?? recallConfig.maxFiles,
				maxFileBytes: recallConfig.maxFileBytes,
				maxSessionBytes: recallConfig.maxSessionBytes,
			};
			// The candidate window does not depend on the query.
			const captured: string[] = [];
			await recall(
				fixture.sources,
				"window probe",
				async (input) => {
					captured.push(...input.candidates.map((c) => recallKey(c.scope, c.path)));
					return [];
				},
				limits,
			);
			const window = new Set(captured);
			log(`size=${size}: ${corpus.topics.length} topics, ${corpus.queries.length} queries, window ${window.size}`);

			for (const kind of options.selectors) {
				const factory: SelectorFactory =
					kind === "llm"
						? await liveFactory({
								modelRef: options.modelRef ?? "",
								timeoutMs: options.timeoutMs ?? recallConfig.timeoutMs,
								maxFiles: limits.maxFiles,
							})
						: offlineFactory(kind, fixture, limits.maxFiles, limits.maxCandidates);

				const jobs = corpus.queries.flatMap((query) => Array.from({ length: options.repeats }, (_, repeat) => ({ query, repeat })));
				const runs = await mapPool(jobs, options.concurrency, async ({ query }): Promise<Run> => {
					const handle = factory(query);
					const { value, ms } = await timed(() => recall(fixture.sources, query.text, handle.selector, limits));
					return {
						selected: value.files.map((file) => recallKey(file.scope, file.path)),
						ms,
						usage: handle.usage(),
						skipped: value.skippedReason,
					};
				});
				const byQuery = new Map<string, Run[]>();
				jobs.forEach(({ query }, i) => {
					const list = byQuery.get(query.id) ?? [];
					list.push(runs[i] as Run);
					byQuery.set(query.id, list);
				});
				const scores = corpus.queries.map((query) => score(query, window, byQuery.get(query.id) ?? []));

				const all = scores.filter(isPositive);
				const overall = sliceRow(size, kind, "all", all, false);
				const latencies = runs.map((r) => r.ms);
				const usage = runs.map((r) => r.usage ?? NO_USAGE);
				const negatives = scores.filter((s) => !isPositive(s));
				Object.assign(overall.metrics, {
					n_queries: scores.length,
					false_recall: negatives.length ? mean(negatives.map((s) => s.falseRecall)) : null,
					p50_ms: percentile(latencies, 50),
					p95_ms: percentile(latencies, 95),
					tokens_in_per_query: mean(scores.map((s) => s.input)),
					tokens_out_per_query: mean(scores.map((s) => s.output)),
					degraded_rate: mean(scores.map((s) => s.degraded)),
					flip_rate: avgOrNull(scores.map((s) => s.flip)),
					model_calls: usage.reduce((sum, u) => sum + u.calls, 0),
				});
				result.rows.push(overall);
				for (const slice of SLICES) {
					const matched = scores.filter(slice.match);
					if (matched.length) result.rows.push(sliceRow(size, kind, slice.name, matched, slice.negative === true));
				}
				log(`size=${size} sel=${kind}: done`);
			}
		} finally {
			await fixture.cleanup();
		}
	}
}

const num = (row: Row, key: string) => {
	const value = row.metrics[key];
	return typeof value === "number" ? value : undefined;
};

export function printEvalSummary(rows: readonly Row[], showSlices: boolean): void {
	const main = rows.filter((r) => r.metrics.slice === "all");
	console.log("\nL2 recall quality (positives; k = maxFiles)");
	printTable(
		["size", "selector", "recall", "±95%", "hit", "prec", "in-win", "cover", "FR(neg)", "p50ms", "p95ms", "tok/q", "degr", "flip"],
		main.map((row) => [
			String(row.metrics.size),
			String(row.metrics.sel),
			pct(num(row, "recall")),
			pct(num(row, "recall_ci95")),
			pct(num(row, "hit")),
			pct(num(row, "precision")),
			pct(num(row, "recall_in_window")),
			pct(num(row, "coverage")),
			pct(num(row, "false_recall")),
			format(num(row, "p50_ms"), 1),
			format(num(row, "p95_ms"), 1),
			format((num(row, "tokens_in_per_query") ?? 0) + (num(row, "tokens_out_per_query") ?? 0), 0),
			pct(num(row, "degraded_rate")),
			pct(num(row, "flip_rate")),
		]),
	);
	console.log(
		"\nrecall = share of gold topics returned (window misses count); in-win = recall over gold inside the candidate window;\ncover = share of gold inside the window (ceiling for any selector); FR(neg) = negatives that returned any memory.",
	);
	if (!showSlices) return;
	console.log("\nSlices");
	printTable(
		["size", "selector", "slice", "n", "recall", "hit", "in-win", "false-recall"],
		rows
			.filter((r) => r.metrics.slice !== "all")
			.map((row) => [
				String(row.metrics.size),
				String(row.metrics.sel),
				String(row.metrics.slice),
				String(row.metrics.n),
				pct(num(row, "recall")),
				pct(num(row, "hit")),
				pct(num(row, "recall_in_window")),
				pct(num(row, "false_recall")),
			]),
	);
}
