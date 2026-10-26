import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { byteLength } from "../src/core/format.ts";
import { isRecallWorthy, type RecallSource, recall, searchStore, truncateUtf8 } from "../src/core/recall.ts";
import { MemoryStore } from "../src/core/store.ts";

const cleanups: string[] = [];

async function tempStore(prefix = "cc-memory-recall-"): Promise<MemoryStore> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(dir);
	const store = new MemoryStore({ root: dir });
	await store.init();
	return store;
}

async function seededProject(): Promise<MemoryStore> {
	const store = await tempStore();
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
const projectSources = (store: MemoryStore): RecallSource[] => [{ scope: "project", store }];

describe("recall", () => {
	test("accepts CJK requests without spaces", () => {
		assert.equal(isRecallWorthy("部署流程是怎样的？"), true);
		assert.equal(isRecallWorthy("  "), false);
		assert.equal(isRecallWorthy("a"), false);
	});

	test("returns only candidate paths chosen by the selector", async () => {
		const store = await seededProject();
		const result = await recall(projectSources(store), "how do deploys work", async () => ["deploy.md", "not-a-candidate.md"], limits);

		assert.deepEqual(
			result.files.map((file) => `${file.scope}:${file.path}`),
			["project:deploy.md"],
		);
		assert.match(result.files[0]?.content ?? "", /release branch/);
	});

	test("qualifies the manifest with scope and accepts scope:path selections", async () => {
		const project = await seededProject();
		const global = await tempStore("cc-memory-recall-global-");
		await global.upsert({
			path: "style.md",
			title: "Global style",
			type: "user",
			description: "cross-project style",
			body: "Answer in Chinese.",
		});

		let manifest = "";
		const result = await recall(
			[
				{ scope: "project", store: project },
				{ scope: "global", store: global },
			],
			"style",
			async (input) => {
				manifest = input.manifest;
				return ["global:style.md"];
			},
			limits,
		);

		assert.match(manifest, /project:style\.md/);
		assert.match(manifest, /global:style\.md/);
		assert.deepEqual(
			result.files.map((file) => `${file.scope}:${file.path}`),
			["global:style.md"],
		);
		assert.match(result.files[0]?.content ?? "", /Answer in Chinese/);
	});

	test("resolves a bare path project-first", async () => {
		const project = await seededProject();
		const global = await tempStore("cc-memory-recall-global-");
		await global.upsert({ path: "style.md", title: "Global style", type: "user", description: "cross-project style", body: "global body" });

		const result = await recall(
			[
				{ scope: "project", store: project },
				{ scope: "global", store: global },
			],
			"style",
			async () => ["style.md"],
			limits,
		);

		assert.deepEqual(
			result.files.map((file) => `${file.scope}:${file.path}`),
			["project:style.md"],
		);
	});

	test("respects maxFiles and already surfaced keys", async () => {
		const store = await seededProject();
		const result = await recall(store ? projectSources(store) : [], "answers and deploy", async () => ["deploy.md", "style.md"], {
			...limits,
			maxFiles: 1,
			alreadySurfacedPaths: new Set(["project:style.md"]),
		});

		assert.deepEqual(
			result.files.map((file) => `${file.scope}:${file.path}`),
			["project:deploy.md"],
		);
	});

	test("stops when the session budget is exhausted", async () => {
		const store = await seededProject();
		const result = await recall(projectSources(store), "deploy", async () => ["deploy.md"], {
			...limits,
			maxSessionBytes: 10,
			alreadySurfacedBytes: 10,
		});

		assert.equal(result.files.length, 0);
		assert.equal(result.skippedReason, "session-budget");
	});

	test("degrades to no recall when the selector fails", async () => {
		const store = await seededProject();
		const result = await recall(
			projectSources(store),
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
		const store = await seededProject();
		const hits = await searchStore(store, "release", { limit: 5, candidates: 50 });
		assert.deepEqual(
			hits.map((hit) => hit.path),
			["deploy.md"],
		);
	});
});
