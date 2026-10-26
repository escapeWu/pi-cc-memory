/** Child process fixture for real cross-process store validation. */

import { withStoreLock } from "../../src/adapters/store-lock.ts";
import { MemoryStore } from "../../src/core/store.ts";

const [mode, root, value] = process.argv.slice(2);
if (!root) throw new Error("store root is required");
const store = new MemoryStore({ root });
if (mode === "hold") {
	await withStoreLock(root, async () => {
		process.send?.("locked");
		await new Promise<void>((resolve) => process.once("message", () => resolve()));
	});
} else if (mode === "restore") {
	if (!value) throw new Error("recovery id required");
	const result = await store.restore(value);
	process.send?.(result);
} else {
	for (let i = 0; i < 4; i++) {
		await store.upsert({
			path: `job-${value}-${i}.md`,
			title: `job ${value}`,
			type: "project",
			description: "concurrent fixture",
			body: `content-${value}-${i}`,
		});
		await store.upsert({
			path: "shared.md",
			title: "Shared",
			type: "project",
			description: "contended fixture",
			body: `writer-${value}-${"中文😀".repeat(300)}`,
		});
	}
}
process.disconnect?.();
