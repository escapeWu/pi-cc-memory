import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withStoreLock } from "../src/adapters/store-lock.ts";
import { MemoryStore } from "../src/core/store.ts";
import type { IndexEntry } from "../src/core/types.ts";
import { fixture, required } from "./integration/host.ts";

const topic = { path: "topic.md", title: "Topic", type: "project" as const, description: "fixture", body: "中文\n\nexact content" };
function worker(mode: string, root: string, value = "") {
	const child = fork(fileURLToPath(new URL("./fixtures/store-process.ts", import.meta.url)), [mode, root, value], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let errors = "";
	child.stderr?.on("data", (chunk) => {
		errors += String(chunk);
	});
	const finished = once(child, "exit").then(([code, signal]) => {
		if (code !== 0) throw new Error(`store worker failed (${code}/${signal}): ${errors}`);
	});
	// Attach a rejection observer even for the intentionally killed fixture.
	void finished.catch(() => {});
	return { child, finished };
}

test("independent processes preserve every pointer and complete contended topic", { timeout: 30000 }, async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const root = join(f.root, "store");
	await Promise.all(Array.from({ length: 5 }, (_, i) => worker("write", root, String(i)).finished));
	const store = new MemoryStore({ root });
	assert.equal((await store.readIndexEntries()).length, 21);
	assert.equal((await store.listHeaders(100)).length, 21);
	const shared = await store.readTopic("shared.md");
	assert.match(required(shared).body, /^writer-[0-4]-/);
	assert.equal(required(shared).body.slice(9), "中文😀".repeat(300));
});

test("live locks time out and SIGKILL locks are reclaimed after staleness", { timeout: 30000 }, async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const root = join(f.root, "store");
	const holder = worker("hold", root);
	t.after(() => {
		if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill("SIGKILL");
	});
	await once(holder.child, "message");
	await assert.rejects(
		withStoreLock(root, async () => assert.fail("must not enter live lock"), 100),
		/lock could not be acquired/,
	);
	const exit = once(holder.child, "exit");
	holder.child.kill("SIGKILL");
	await exit;
	await new MemoryStore({ root }).upsert(topic);
	assert.equal((await new MemoryStore({ root }).readIndexEntries()).length, 1);
});

test("forget records exact bytes; a fresh process restores and retries idempotently", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const store = new MemoryStore({ root: join(f.root, "store") });
	await store.upsert(topic);
	const original = await readFile(join(store.root, "topic.md"), "utf8");
	const result = await store.forget("topic.md");
	assert.ok(result.recoveryId);
	assert.equal((await store.forget("topic.md")).recoveryId, undefined);
	assert.deepEqual(await store.listHeaders(), []);
	assert.deepEqual(await store.readIndexEntries(), []);
	await worker("restore", store.root, result.recoveryId).finished;
	assert.equal(await readFile(join(store.root, "topic.md"), "utf8"), original);
	assert.equal((await store.restore(result.recoveryId)).alreadyRestored, true);
	assert.equal((await store.readIndexEntries()).length, 1);
});

test("restore rejects newer content, damaged records, unsafe ids and recovery symlinks", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const store = new MemoryStore({ root: join(f.root, "store") });
	await store.upsert(topic);
	const id = required((await store.forget("topic.md")).recoveryId);
	await store.upsert({ ...topic, body: "newer content" });
	await assert.rejects(store.restore(id), /overwrite/);
	assert.equal((await store.readTopic("topic.md"))?.body, "newer content");
	await assert.rejects(store.restore("../topic"), /invalid memory recovery id/);
	const path = join(store.root, ".recovery", `${id}.json`);
	const record = JSON.parse(await readFile(path, "utf8"));
	record.content = "tampered";
	await writeFile(path, JSON.stringify(record));
	await assert.rejects(store.restore(id), /damaged/);
	const newStore = new MemoryStore({ root: join(f.root, "other") });
	await newStore.init();
	await symlink(join(store.root, ".recovery"), join(newStore.root, ".recovery"));
	await assert.rejects(newStore.restore(id), /symlink/);
});

test("index failure rolls back forget/restore and retains recovery evidence", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	class FailingStore extends MemoryStore {
		fail = false;
		protected override async writeIndex(entries: readonly IndexEntry[]) {
			if (this.fail) throw new Error("fixture index failure");
			return super.writeIndex(entries);
		}
	}
	const store = new FailingStore({ root: join(f.root, "store") });
	await store.upsert(topic);
	store.fail = true;
	await assert.rejects(store.forget("topic.md"), /rolled back/);
	assert.equal((await store.readTopic("topic.md"))?.body, topic.body);
	assert.equal((await store.readIndexEntries()).length, 1);
	assert.equal((await readdir(join(store.root, ".recovery"))).length, 1);
	store.fail = false;
	const id = required((await store.forget("topic.md")).recoveryId);
	store.fail = true;
	await assert.rejects(store.restore(id), /record retained/);
	assert.equal(await store.readTopic("topic.md"), undefined);
	store.fail = false;
	await store.restore(id);
	assert.equal((await store.readTopic("topic.md"))?.body, topic.body);
});
