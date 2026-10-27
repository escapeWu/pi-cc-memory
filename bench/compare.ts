/**
 * Compare two result files of the same benchmark: `node bench/compare.ts before.json after.json`.
 * Rows are matched by label; every numeric metric present in both is diffed.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type BenchResult, format, printTable } from "./lib/report.ts";

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { metric: { type: "string", multiple: true }, "min-change": { type: "string", default: "0.02" } },
});
const [beforePath, afterPath] = positionals;
if (!beforePath || !afterPath) throw new Error("usage: compare.ts <before.json> <after.json> [--metric name]... [--min-change 0.02]");

const load = async (path: string) => JSON.parse(await readFile(path, "utf8")) as BenchResult;
const [before, after] = await Promise.all([load(beforePath), load(afterPath)]);
if (before.name !== after.name) throw new Error(`cannot compare ${before.name} with ${after.name}`);
console.log(`before: ${before.env.commit}${before.env.dirty ? "+dirty" : ""} ${before.startedAt}`);
console.log(`after:  ${after.env.commit}${after.env.dirty ? "+dirty" : ""} ${after.startedAt}`);

const wanted = values.metric?.length ? new Set(values.metric) : undefined;
const threshold = Number(values["min-change"]);
const previous = new Map(before.rows.map((row) => [row.label, row]));
const lines: string[][] = [];
for (const row of after.rows) {
	const old = previous.get(row.label);
	if (!old) continue;
	for (const [key, value] of Object.entries(row.metrics)) {
		const prior = old.metrics[key];
		if (typeof value !== "number" || typeof prior !== "number" || Number.isNaN(value) || Number.isNaN(prior)) continue;
		if (wanted && !wanted.has(key)) continue;
		const delta = value - prior;
		const relative = prior === 0 ? (delta === 0 ? 0 : Number.POSITIVE_INFINITY) : delta / Math.abs(prior);
		if (Math.abs(relative) < threshold) continue;
		lines.push([
			row.label,
			key,
			format(prior, 3),
			format(value, 3),
			`${delta >= 0 ? "+" : ""}${format(delta, 3)}`,
			`${(relative * 100).toFixed(1)}%`,
		]);
	}
}
if (!lines.length) console.log(`\nno metric changed by >= ${threshold * 100}%`);
else printTable(["row", "metric", "before", "after", "delta", "rel"], lines);
