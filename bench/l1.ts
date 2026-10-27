/** L1 micro-benchmarks. No model, no network. See bench/README.md. */
import { parseArgs } from "node:util";
import { printMicroSummary, runMicro } from "./lib/micro.ts";
import { newResult, writeResult } from "./lib/report.ts";

const { values } = parseArgs({
	options: {
		sizes: { type: "string", default: "50,200,1000,5000" },
		iterations: { type: "string", default: "15" },
		contention: { type: "string", default: "" },
		"contention-ops": { type: "string", default: "12" },
		seed: { type: "string", default: "1" },
		out: { type: "string" },
	},
});
const list = (text: string) =>
	text
		.split(",")
		.map((part) => Number(part.trim()))
		.filter((n) => Number.isFinite(n) && n > 0);

const options = {
	sizes: list(values.sizes),
	iterations: Number(values.iterations),
	contention: list(values.contention),
	contentionOps: Number(values["contention-ops"]),
	seed: Number(values.seed),
	log: (message: string) => console.error(message),
};
const result = newResult("l1", { ...options, log: undefined });
await runMicro(options, result);
printMicroSummary(result.rows);
console.log(`\nresult: ${await writeResult(result, values.out)}`);
