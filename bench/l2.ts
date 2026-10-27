/**
 * L2 recall-quality evaluation. Offline selectors run without a network; add
 * `llm` (needs PI_CC_MEMORY_LIVE_MODEL or --model) to score the real selector.
 */
import { parseArgs } from "node:util";
import { printEvalSummary, runRecallEval } from "./lib/recall-eval.ts";
import { newResult, writeResult } from "./lib/report.ts";
import { OFFLINE_KINDS, type SelectorKind } from "./lib/selectors.ts";

const { values } = parseArgs({
	options: {
		sizes: { type: "string", default: "20,100,400" },
		selectors: { type: "string", default: OFFLINE_KINDS.join(",") },
		model: { type: "string" },
		seed: { type: "string", default: "1" },
		positives: { type: "string", default: "24" },
		multi: { type: "string", default: "6" },
		"near-miss": { type: "string", default: "8" },
		"off-topic": { type: "string", default: "8" },
		zh: { type: "string", default: "0.5" },
		repeats: { type: "string", default: "1" },
		concurrency: { type: "string", default: "1" },
		"max-candidates": { type: "string" },
		"max-files": { type: "string" },
		"timeout-ms": { type: "string" },
		slices: { type: "boolean", default: false },
		out: { type: "string" },
	},
});
const kinds = new Set<string>([...OFFLINE_KINDS, "llm"]);
const selectors = values.selectors.split(",").map((s) => s.trim());
for (const selector of selectors)
	if (!kinds.has(selector)) throw new Error(`unknown selector "${selector}" (expected ${[...kinds].join(", ")})`);
const modelRef = values.model ?? process.env.PI_CC_MEMORY_LIVE_MODEL;
if (selectors.includes("llm") && !modelRef) throw new Error("selector llm needs --model provider/id or PI_CC_MEMORY_LIVE_MODEL");
const maybe = (key: string, text: string | undefined) => (text === undefined ? {} : { [key]: Number(text) });

const options = {
	sizes: values.sizes.split(",").map(Number),
	selectors: selectors as SelectorKind[],
	corpus: {
		seed: Number(values.seed),
		positives: Number(values.positives),
		multi: Number(values.multi),
		nearMiss: Number(values["near-miss"]),
		offTopic: Number(values["off-topic"]),
		zhFraction: Number(values.zh),
	},
	repeats: Number(values.repeats),
	concurrency: Number(values.concurrency),
	...maybe("maxCandidates", values["max-candidates"]),
	...maybe("maxFiles", values["max-files"]),
	...maybe("timeoutMs", values["timeout-ms"]),
	...(modelRef ? { modelRef } : {}),
	log: (message: string) => console.error(message),
};
const result = newResult("l2", { ...options, log: undefined });
await runRecallEval(options, result);
printEvalSummary(result.rows, values.slices);
console.log(`\nresult: ${await writeResult(result, values.out)}`);
