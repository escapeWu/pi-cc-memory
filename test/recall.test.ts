import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { byteLength } from "../src/core/format.ts";
import { isRecallWorthy, recall, searchStore, truncateUtf8 } from "../src/core/recall.ts";
import { MemoryStore } from "../src/core/store.ts";

const cleanups: string[] = [];

async function seededStore(): Promise<MemoryStore> {
	const dir = await mkdtemp(join(tmpdir(), "cc-memory-recall-"));
	cleanups.push(dir);
	const store = new MemoryStore({ root: dir });
	await store.init();
	await store.upsert({
		path: "deploy.md",
		title: "Deploy",
		type: "project",
		description: "how deploys work",
		body: "Deploys run from the release branch.",
	});
	await store.upsert({ path: "style.md", title: "Style", type: "feedback", description: "answer style", body: "Prefer concise answers." });
	return store;
}

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const limits = { maxCandidates: 200, maxFiles: 5, maxFileBytes: 4096, maxSessionBytes: 60 * 1024 };

describe("recall", () => {
	test("accepts CJK requests without spaces", () => {
		assert.equal(isRecallWorthy("部署流程是怎样的？"), true);
		assert.equal(isRecallWorthy("  "), false);
		assert.equal(isRecallWorthy("a"), false);
	});

	test("returns only candidate paths chosen by the selector", async () => {
		const store = await seededStore();
		const result = await recall(store, "how do deploys work", async () => ["deploy.md", "not-a-candidate.md"], limits);

		assert.deepEqual(
			result.files.map((file) => file.path),
			["deploy.md"],
		);
		assert.match(result.files[0]?.content ?? "", /release branch/);
	});

	test("respects maxFiles and already surfaced paths", async () => {
		const store = await seededStore();
		const result = await recall(store, "answers and deploy", async () => ["deploy.md", "style.md"], {
			...limits,
			maxFiles: 1,
			alreadySurfacedPaths: new Set(["style.md"]),
		});

		assert.deepEqual(
			result.files.map((file) => file.path),
			["deploy.md"],
		);
	});

	test("stops when the session budget is exhausted", async () => {
		const store = await seededStore();
		const result = await recall(store, "deploy", async () => ["deploy.md"], {
			...limits,
			maxSessionBytes: 10,
			alreadySurfacedBytes: 10,
		});

		assert.equal(result.files.length, 0);
		assert.equal(result.skippedReason, "session-budget");
	});

	test("degrades to no recall when the selector fails", async () => {
		const store = await seededStore();
		const result = await recall(
			store,
			"deploy",
			async () => {
				throw new Error("model down");
			},
			limits,
		);

		assert.equal(result.files.length, 0);
		assert.equal(result.skippedReason, "selector-failed");
	});

	test("never splits a multi-byte character", () => {
		const text = "中文内容".repeat(100);
		const cut = truncateUtf8(text, 9);
		assert.ok(byteLength(cut) <= 9);
		assert.equal(text.startsWith(cut), true);
	});

	test("linear search finds narrow terms", async () => {
		const store = await seededStore();
		const hits = await searchStore(store, "release", { limit: 5, candidates: 50 });
		assert.deepEqual(
			hits.map((hit) => hit.path),
			["deploy.md"],
		);
	});
});
