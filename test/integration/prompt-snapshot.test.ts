import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PROMPT_SNAPSHOT_ENTRY } from "../../src/adapters/prompt-snapshot.ts";
import { resolveProjectIdentity } from "../../src/core/identity.ts";
import { MemoryStore } from "../../src/core/store.ts";
import { fakeRuntime, fixture, openHost, required } from "./host.ts";

const topic = {
	path: "snapshot.md",
	title: "Snapshot",
	type: "project" as const,
	description: "ORIGINAL_INDEX_FACT",
	body: "Original body.",
};
const command = (args: object) => `MEMORY_CALL ${JSON.stringify(args)}`;
const stores = (f: Awaited<ReturnType<typeof fixture>>) => ({
	project: new MemoryStore({ root: join(f.agentDir, "cc-memory/projects", resolveProjectIdentity(f.cwd).slug) }),
	global: new MemoryStore({ root: join(f.agentDir, "cc-memory/global") }),
});

// These exercise real Pi sessions and observe the model input, not a hook mock.
test("SDK snapshot keeps the prefix across writes, external changes, resume and fork", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	const { project, global } = stores(f);
	await project.upsert(topic);
	await global.upsert({ ...topic, type: "user", description: "GLOBAL_ORIGINAL_FACT" });
	const host = await openHost({ ...f, ...model });
	let prompt: string;
	let file: string;
	try {
		await host.session.prompt("Read the initial snapshot.");
		prompt = required(model.requests.at(-1)).prompt;
		assert.match(prompt, /ORIGINAL_INDEX_FACT/);
		await host.session.prompt(command({ action: "write", scope: "project", ...topic, description: "NEW_WRITTEN_FACT" }));
		await global.upsert({ ...topic, type: "user", description: "GLOBAL_EXTERNAL_FACT" });
		await host.session.prompt("Continue after ordinary and external writes.");
		assert.equal(required(model.requests.at(-1)).prompt, prompt);
		await host.session.prompt(command({ action: "index", scope: "project" }));
		assert.match(JSON.stringify(host.session.messages.at(-2)), /NEW_WRITTEN_FACT/);
		assert.equal(required(model.requests.at(-1)).prompt, prompt);
		assert.equal(host.manager.getBranch().filter((e) => e.type === "custom" && e.customType === PROMPT_SNAPSHOT_ENTRY).length, 1);
		assert.equal(host.session.messages.filter((message) => message.role === "system").length, 1);
		assert.doesNotMatch(required(model.requests.at(-1)).text, /cc-memory\/prompt-snapshot/);
		file = required(host.manager.getSessionFile());
	} finally {
		await host.close();
	}
	for (const manager of [SessionManager.open(file), SessionManager.forkFrom(file, f.cwd, join(f.agentDir, "forks"))]) {
		const next = await openHost({ ...f, ...model, manager });
		try {
			await next.session.prompt("Resume the same snapshot.");
			assert.equal(required(model.requests.at(-1)).prompt, prompt);
		} finally {
			await next.close();
		}
	}
	const fresh = await openHost({ ...f, ...model });
	try {
		await fresh.session.prompt("Read a fresh snapshot.");
		assert.match(required(model.requests.at(-1)).prompt, /NEW_WRITTEN_FACT/);
		assert.match(required(model.requests.at(-1)).prompt, /GLOBAL_EXTERNAL_FACT/);
	} finally {
		await fresh.close();
	}
});

test("SDK snapshot refreshes after successful compaction, but not cancelled compaction", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	const { project } = stores(f);
	await project.upsert(topic);
	let cancel = true;
	const host = await openHost({
		...f,
		...model,
		extra: (pi) => {
			pi.on("session_before_compact", () => (cancel ? { cancel: true } : undefined));
		},
	});
	try {
		await host.session.prompt("Initial context.");
		const original = required(model.requests.at(-1)).prompt;
		await project.upsert({ ...topic, description: "AFTER_COMPACTION_FACT" });
		await assert.rejects(host.session.compact(), /cancel/i);
		await host.session.prompt("Continue after cancellation.");
		assert.equal(required(model.requests.at(-1)).prompt, original);
		cancel = false;
		await host.session.compact();
		await host.session.prompt("Continue after successful compaction.");
		const refreshed = required(model.requests.at(-1)).prompt;
		assert.match(refreshed, /AFTER_COMPACTION_FACT/);
		assert.doesNotMatch(refreshed, /ORIGINAL_INDEX_FACT/);
		await project.upsert({ ...topic, description: "LATER_EXTERNAL_FACT" });
		await host.session.prompt("Keep the post-compaction snapshot.");
		assert.equal(required(model.requests.at(-1)).prompt, refreshed);
	} finally {
		await host.close();
	}
});

test("SDK forget/restore refresh the snapshot, while tree navigation restores its own branch", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	await stores(f).project.upsert(topic);
	const host = await openHost({ ...f, ...model });
	try {
		await host.session.prompt("Capture the original branch.");
		const original = required(model.requests.at(-1)).prompt;
		const branchPoint = host.manager.getLeafId();
		assert.ok(branchPoint);
		await host.session.prompt(command({ action: "forget", scope: "project", path: topic.path }));
		const result = host.session.messages.at(-2);
		assert.ok(result?.role === "toolResult" && !result.isError);
		const recoveryId = (result.details as { recoveryId: string }).recoveryId;
		await host.session.prompt("Observe the forgotten index.");
		assert.doesNotMatch(required(model.requests.at(-1)).prompt, /ORIGINAL_INDEX_FACT/);
		await host.session.prompt(command({ action: "restore", scope: "project", recoveryId }));
		await host.session.prompt("Observe the restored index.");
		assert.match(required(model.requests.at(-1)).prompt, /ORIGINAL_INDEX_FACT/);
		await stores(f).project.upsert({ ...topic, description: "OTHER_BRANCH_DISK_FACT" });
		await host.session.navigateTree(branchPoint, { summarize: false });
		await host.session.prompt("Start an alternative branch.");
		assert.equal(required(model.requests.at(-1)).prompt, original);
	} finally {
		await host.close();
	}
});

test("SDK migrates a legacy system snapshot without resampling or double wrapping", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	await stores(f).project.upsert(topic);
	const host = await openHost({ ...f, ...model });
	const manager = SessionManager.create(f.cwd, join(f.agentDir, "legacy"));
	let original: string;
	try {
		await host.session.prompt("Capture a legacy transcript.");
		original = required(model.requests.at(-1)).prompt;
		// Copy context messages only, as pre-fix sessions had no snapshot metadata.
		for (const message of host.session.messages) {
			if (message.role !== "branchSummary" && message.role !== "compactionSummary") manager.appendMessage(message);
		}
	} finally {
		await host.close();
	}
	await stores(f).project.upsert({ ...topic, description: "NEWER_DISK_FACT" });
	const resumed = await openHost({ ...f, ...model, manager });
	try {
		await resumed.session.prompt("Upgrade this old conversation.");
		assert.equal(required(model.requests.at(-1)).prompt, original);
		assert.equal((original.match(/<pi_memory>/g) ?? []).length, 1);
	} finally {
		await resumed.close();
	}
});

test("SDK restoring a snapshot cannot re-enable a disabled global store", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	await stores(f).global.upsert({ ...topic, type: "user", description: "GLOBAL_MUST_DISAPPEAR" });
	const host = await openHost({ ...f, ...model });
	let file: string;
	try {
		await host.session.prompt("Capture with global enabled.");
		assert.match(required(model.requests.at(-1)).prompt, /GLOBAL_MUST_DISAPPEAR/);
		file = required(host.manager.getSessionFile());
	} finally {
		await host.close();
	}
	const resumed = await openHost({ ...f, ...model, global: false, manager: SessionManager.open(file) });
	try {
		await resumed.session.prompt("Continue with global disabled.");
		assert.doesNotMatch(required(model.requests.at(-1)).prompt, /GLOBAL_MUST_DISAPPEAR/);
		assert.match(required(model.requests.at(-1)).prompt, /global.*disabled/);
	} finally {
		await resumed.close();
	}
});
