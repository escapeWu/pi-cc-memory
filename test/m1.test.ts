import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiSelector } from "../src/adapters/pi-model.ts";
import { byteLength } from "../src/core/format.ts";
import { formatRecallMessage, recall, truncateUtf8 } from "../src/core/recall.ts";
import { MemoryRouter } from "../src/core/router.ts";
import { MemoryStore } from "../src/core/store.ts";
import { fixture } from "./integration/host.ts";

const topic = { path: "deploy.md", title: "Deploy", type: "project" as const, description: "release", body: "中文😀🚀".repeat(400) };

test("new topic beneath a symlinked parent is rejected before any external write", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const store = new MemoryStore({ root: join(f.root, "store") });
	await store.init();
	const outside = join(f.root, "outside");
	await mkdir(outside);
	await symlink(outside, join(store.root, "linked"));
	await assert.rejects(store.upsert({ ...topic, path: "linked/new.md" }), /symlink/);
	await assert.rejects(readFile(join(outside, "new.md")), /ENOENT/);
	await assert.rejects(store.upsert({ ...topic, path: "nested/.hidden/new.md" }), /hidden/);
	await symlink(join(outside, "index.md"), store.indexPath);
	await assert.rejects(store.readIndex(), /symlink/);
});

test("bounded index views keep complete entries on disk across later writes", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const store = new MemoryStore({ root: join(f.root, "store"), indexLimits: { maxBytes: 150, maxLines: 3 } });
	await store.init();
	await writeFile(store.indexPath, Array.from({ length: 20 }, (_, i) => `- [T${i}](t${i}.md) — 中文索引`).join("\n"));
	const view = await store.readIndex();
	assert.ok(byteLength(view) <= 150);
	assert.ok(view.split("\n").length <= 3);
	assert.match(view, /WARNING/);
	await store.upsert(topic);
	assert.equal((await store.readIndexEntries()).length, 21);
});

test("scoped list/search apply the limit within the requested store", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const router = new MemoryRouter({
		project: new MemoryStore({ root: join(f.root, "p") }),
		global: new MemoryStore({ root: join(f.root, "g") }),
		globalEnabled: true,
		defaultScope: "project",
	});
	await router.write({ ...topic, scope: "global" });
	await router.write({ ...topic, scope: "project" });
	assert.equal((await router.listHeaders(1, "global"))[0]?.scope, "global");
	assert.equal((await router.search("release", { limit: 1, candidates: 50, scope: "global" }))[0]?.scope, "global");
});

test("recall caps complete message bytes including wrapper, separators and truncation notice", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const store = new MemoryStore({ root: join(f.root, "store") });
	await store.upsert(topic);
	await store.upsert({ ...topic, path: "other.md" });
	const result = await recall([{ scope: "project", store }], "部署流程？", async () => ["deploy.md", "other.md"], {
		maxCandidates: 20,
		maxFiles: 5,
		maxFileBytes: 400,
		maxSessionBytes: 600,
		alreadySurfacedBytes: 50,
	});
	assert.ok(result.files.length > 0);
	assert.ok(byteLength(formatRecallMessage(result.files)) <= 550);
	for (const file of result.files) {
		assert.ok(byteLength(formatRecallMessage([file])) <= 400);
		assert.equal(Buffer.from(file.content).toString("utf8"), file.content);
	}
	for (let cap = 0; cap < 12; cap++) {
		const cut = truncateUtf8("中文😀🚀", cap);
		assert.equal(Buffer.from(cut).toString("utf8"), cut);
	}
});

test("bare selector paths resolve global when no project candidate matches", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const store = new MemoryStore({ root: join(f.root, "global") });
	await store.upsert(topic);
	const result = await recall([{ scope: "global", store }], "部署流程？", async () => ["deploy.md"], {
		maxCandidates: 20,
		maxFiles: 5,
		maxFileBytes: 400,
		maxSessionBytes: 1000,
	});
	assert.equal(result.files[0]?.scope, "global");
});

test("selector deadline and cancellation do not depend on provider abort cooperation", async () => {
	let calls = 0;
	const controller = new AbortController();
	const ctx = {
		model: { id: "test", provider: "fixture" },
		signal: controller.signal,
		modelRegistry: {
			streamSimple() {
				calls++;
				return { result: () => new Promise(() => {}) };
			},
		},
	} as unknown as ExtensionContext;
	const input = { query: "deploy", manifest: "", candidates: [] };
	const started = Date.now();
	assert.deepEqual(await createPiSelector(ctx, { timeoutMs: 20 })(input), []);
	assert.ok(Date.now() - started < 1000);
	controller.abort();
	assert.deepEqual(await createPiSelector(ctx, { timeoutMs: 1000 })(input), []);
	assert.equal(calls, 1);
});
