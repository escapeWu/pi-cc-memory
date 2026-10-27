/**
 * Contention worker: waits for "go", then performs `ops` real upserts against a
 * shared store (half to a private topic, half to one shared topic) and reports
 * each operation's latency. Spawned by bench/lib/micro.ts.
 */
import { MemoryStore } from "../../src/core/store.ts";

const [root, opsText, id] = process.argv.slice(2);
if (!root || !opsText || !id) throw new Error("usage: writer.ts <root> <ops> <id>");
const ops = Number(opsText);
const store = new MemoryStore({ root });

process.once("message", async () => {
	const latencies: number[] = [];
	let failures = 0;
	for (let i = 0; i < ops; i++) {
		const shared = i % 2 === 1;
		const start = performance.now();
		try {
			await store.upsert({
				path: shared ? "shared.md" : `writer-${id}-${i}.md`,
				title: shared ? "Shared" : `Writer ${id} ${i}`,
				type: "project",
				description: shared ? "contended topic" : "private topic",
				body: `writer ${id} op ${i}`,
			});
		} catch {
			failures++;
		}
		latencies.push(performance.now() - start);
	}
	process.send?.({ latencies, failures }, () => process.exit(0));
});
process.send?.("ready");
