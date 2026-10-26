import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { MemoryStore } from "../src/core/store.ts";

const cleanups: string[] = [];

async function tempStore(): Promise<MemoryStore> {
	const dir = await mkdtemp(join(tmpdir(), "cc-memory-"));
	cleanups.push(dir);
	const store = new MemoryStore({ root: dir, indexLimits: { maxLines: 200, maxBytes: 24_000 } });
	await store.init();
	return store;
}

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MemoryStore", () => {
	test("writes a topic and its index entry atomically", async () => {
		const store = await tempStore();
		const result = await store.upsert({
			title: "Integration tests",
			type: "feedback",
			description: "Real database for migration tests",
			body: "Do not mock the database in migration tests.",
		});

		assert.equal(result.created, true);
		assert.equal(result.indexUpdated, true);
		assert.equal(result.path, "integration-tests.md");
		assert.match(await readFile(join(store.root, result.path), "utf8"), /type: feedback/);

		const index = await store.readIndex();
		assert.match(index, /- \[Integration tests\]\(integration-tests\.md\) — Real database for migration tests/);
	});

	test("updates an existing topic instead of duplicating the index entry", async () => {
		const store = await tempStore();
		await store.upsert({ path: "a.md", title: "A", type: "project", description: "first", body: "one" });
		const result = await store.upsert({ path: "a.md", title: "A", type: "project", description: "second", body: "two" });

		assert.equal(result.created, false);
		const entries = await store.readIndexEntries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.hook, "second");
	});

	test("forget removes the file and its index entry", async () => {
		const store = await tempStore();
		await store.upsert({ path: "a.md", title: "A", type: "user", description: "hook", body: "body" });
		await store.upsert({ path: "b.md", title: "B", type: "user", description: "hook b", body: "body b" });

		const result = await store.forget("a.md");
		assert.equal(result.fileRemoved, true);
		assert.equal(result.indexUpdated, true);
		assert.deepEqual(
			(await store.readIndexEntries()).map((entry) => entry.path),
			["b.md"],
		);
		assert.equal(await store.readTopic("a.md"), undefined);
	});

	test("serializes concurrent writes without losing index entries", async () => {
		const store = await tempStore();
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				store.upsert({
					path: `topic-${index}.md`,
					title: `Topic ${index}`,
					type: "project",
					description: `hook ${index}`,
					body: `body ${index}`,
				}),
			),
		);

		const paths = (await store.readIndexEntries()).map((entry) => entry.path).sort();
		assert.equal(paths.length, 8);
	});

	test("rejects traversal and symlinked topics", async () => {
		const store = await tempStore();
		await assert.rejects(store.upsert({ path: "../escape.md", title: "x", type: "project", description: "y", body: "z" }));

		const outside = join(tmpdir(), `cc-memory-outside-${Date.now()}.md`);
		await writeFile(outside, "secret");
		await symlink(outside, join(store.root, "linked.md"));
		await assert.rejects(store.readTopic("linked.md"), /symlink/i);
	});

	test("rebuilds a truncated index from disk", async () => {
		const store = await tempStore();
		await store.upsert({ path: "a.md", title: "A", type: "reference", description: "d", body: "b" });
		await store.upsert({ path: "b.md", title: "B", type: "reference", description: "d", body: "b" });

		await writeFile(store.indexPath, "- [stale](missing.md) — stale\n");
		const rebuilt = await store.rebuildIndex();

		assert.equal(rebuilt.entries, 2);
		const index = await store.readIndex();
		assert.doesNotMatch(index, /missing\.md/);
		assert.match(index, /a\.md/);
		assert.match(index, /b\.md/);
	});
});
