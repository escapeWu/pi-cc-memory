import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RECALL_MESSAGE_TYPE, readRecallUsage } from "../../src/adapters/pi-session.ts";
import { resolveProjectIdentity } from "../../src/core/identity.ts";
import { MemoryStore } from "../../src/core/store.ts";
import { fakeRuntime, fixture, openHost, required } from "./host.ts";

const write = {
	action: "write",
	scope: "project",
	path: "deploy.md",
	title: "Deploy",
	type: "project",
	description: "deployment release process",
	body: "Deploy with the violet release lane.",
} as const;

test("Pi runner: write/update, fresh session, resume/fork, scoped tools, command, forget", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	const first = await openHost({ ...f, ...model });
	await first.session.prompt(`MEMORY_CALL ${JSON.stringify(write)}`);
	assert.ok(first.session.messages.some((m) => m.role === "toolResult" && !m.isError));
	const root = join(f.agentDir, "cc-memory/projects", resolveProjectIdentity(f.cwd).slug);
	assert.match(await readFile(join(root, "deploy.md"), "utf8"), /violet/);
	await first.session.prompt(
		`MEMORY_CALL ${JSON.stringify({ ...write, body: "Deploy with the amber release lane.", description: "updated deployment flow" })}`,
	);
	const index = await readFile(join(root, "MEMORY.md"), "utf8");
	assert.equal((index.match(/\]\(deploy.md\)/g) ?? []).length, 1);
	await first.session.prompt(`MEMORY_CALL ${JSON.stringify({ ...write, scope: "global", type: "user", body: "Global preference" })}`);
	await first.session.prompt(`MEMORY_CALL ${JSON.stringify({ action: "list", scope: "global", limit: 1 })}`);
	assert.match(JSON.stringify(first.session.messages.at(-2)), /global\/user/);
	await first.session.prompt(`MEMORY_CALL ${JSON.stringify({ action: "search", scope: "global", query: "Global", limit: 1 })}`);
	assert.match(JSON.stringify(first.session.messages.at(-2)), /global:deploy.md/);
	await first.session.compact();
	await first.session.prompt("Inspect the index after native compaction.");
	assert.match(required(model.requests.at(-1)).prompt, /updated deployment flow/);
	assert.equal((required(model.requests.at(-1)).prompt.match(/<pi_memory>/g) ?? []).length, 1);
	await first.session.prompt("/memory");
	assert.ok(first.notifications.some((m) => m.includes("project store:") && m.includes("global store:")));
	await first.session.prompt("/memory index");
	assert.ok(first.notifications.some((m) => m.includes("# global") && m.includes("# project")));
	const file = required(first.manager.getSessionFile());
	await first.close();

	for (const manager of [undefined, SessionManager.open(file), SessionManager.forkFrom(file, f.cwd, join(f.agentDir, "forks"))]) {
		const next = await openHost({ ...f, ...model, manager });
		try {
			await next.session.prompt("Inspect the saved deployment instructions.");
			const request = required(model.requests.at(-1));
			assert.match(request.prompt, /updated deployment flow/);
			assert.equal((request.prompt.match(/<pi_memory>/g) ?? []).length, 1);
			assert.ok(request.prompt.indexOf("### global") < request.prompt.indexOf("### project"));
			await next.session.prompt('MEMORY_CALL {"action":"read","path":"deploy.md","scope":"project"}');
			assert.match(JSON.stringify(next.session.messages.at(-2)), /amber/);
		} finally {
			await next.close();
		}
	}
	const final = await openHost({ ...f, ...model });
	try {
		await final.session.prompt('MEMORY_CALL {"action":"forget","path":"deploy.md","scope":"project"}');
		await final.session.prompt("Check the remaining index.");
		assert.doesNotMatch(required(required(model.requests.at(-1)).prompt.split("### project")[1]), /deploy.md/);
		assert.match(required(required(model.requests.at(-1)).prompt.split("### global")[1]), /deploy.md/);
	} finally {
		await final.close();
	}
});

test("Pi runner: recall before first answer, tree, native compaction, resume and fork", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	const store = new MemoryStore({ root: join(f.agentDir, "cc-memory/projects", resolveProjectIdentity(f.cwd).slug) });
	await store.upsert(write);
	const host = await openHost({ ...f, ...model, recall: true });
	try {
		await host.session.prompt("部署流程是怎样的？");
		assert.equal(model.requests.length, 2);
		assert.match(required(model.requests[0]).text, /project:deploy.md/);
		assert.match(required(model.requests[1]).text, /violet release lane/);
		assert.doesNotMatch(required(model.requests[1]).prompt, /### project|updated deployment flow/);
		assert.equal((required(model.requests[1]).prompt.match(/<pi_memory>/g) ?? []).length, 1);
		const usage = readRecallUsage(host.context());
		assert.deepEqual([...usage.paths], ["project:deploy.md"]);
		assert.ok(usage.surfacedBytes > 0);
		await host.session.prompt("再说一次部署流程");
		assert.equal(host.manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === RECALL_MESSAGE_TYPE).length, 1);

		const firstUser = required(host.manager.getBranch().find((e) => e.type === "message" && e.message.role === "user"));
		await host.session.navigateTree(firstUser.id, { summarize: false });
		assert.equal(readRecallUsage(host.context()).surfacedBytes, 0);
		await host.session.prompt("这个分支的部署流程？");
		assert.deepEqual([...readRecallUsage(host.context()).paths], ["project:deploy.md"]);
		await host.session.compact();
		assert.ok(host.manager.getBranch().some((e) => e.type === "compaction"));
		assert.equal(readRecallUsage(host.context()).surfacedBytes, 0);
		await host.session.prompt("压缩后请复述部署流程");
		assert.match(required(model.requests.at(-1)).text, /violet release lane/);
		const currentUsage = readRecallUsage(host.context());
		const file = required(host.manager.getSessionFile());
		await host.close();
		for (const manager of [SessionManager.open(file), SessionManager.forkFrom(file, f.cwd, join(f.agentDir, "forks"))]) {
			const restored = await openHost({ ...f, ...model, recall: true, manager });
			try {
				assert.equal(readRecallUsage(restored.context()).surfacedBytes, currentUsage.surfacedBytes);
				await restored.session.prompt("恢复会话后部署流程？");
				assert.equal(readRecallUsage(restored.context()).surfacedBytes, currentUsage.surfacedBytes);
			} finally {
				await restored.close();
			}
		}
	} finally {
		await host.close();
	}
});

test("Pi runner: separate projects share only global; disabling global removes it and errors", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	const project = new MemoryStore({ root: join(f.agentDir, "cc-memory/projects", resolveProjectIdentity(f.cwd).slug) });
	await project.upsert(write);
	const global = new MemoryStore({ root: join(f.agentDir, "cc-memory/global") });
	await global.upsert({ ...write, description: "global unique hook", body: "global unique body" });
	const other = join(f.root, "project-b");
	await mkdir(other);
	for (const enabled of [true, false]) {
		const host = await openHost({ ...f, ...model, cwd: other, global: enabled });
		try {
			await host.session.prompt("Observe stores.");
			assert.doesNotMatch(required(model.requests.at(-1)).prompt, /deployment release process/);
			assert.equal(required(model.requests.at(-1)).prompt.includes("global unique hook"), enabled);
			await host.session.prompt('MEMORY_CALL {"action":"read","scope":"global","path":"deploy.md"}');
			const result = host.session.messages.at(-2);
			assert.ok(result?.role === "toolResult");
			assert.equal(Boolean(result.isError), !enabled);
		} finally {
			await host.close();
		}
	}
});

test("actual Git worktree shares the SDK project store with its main checkout", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const git = (args: string[]) => execFileSync("git", args, { cwd: f.cwd, stdio: "pipe" });
	git(["init"]);
	git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
	const linked = join(f.root, "linked");
	git(["worktree", "add", "-b", "fixture", linked]);
	assert.equal(resolveProjectIdentity(linked).slug, resolveProjectIdentity(f.cwd).slug);
	const model = await fakeRuntime(f.root);
	const original = await openHost({ ...f, ...model });
	try {
		await original.session.prompt(`MEMORY_CALL ${JSON.stringify(write)}`);
	} finally {
		await original.close();
	}
	const worktree = await openHost({ ...f, ...model, cwd: linked });
	try {
		await worktree.session.prompt('MEMORY_CALL {"action":"read","scope":"project","path":"deploy.md"}');
		assert.match(JSON.stringify(worktree.session.messages.at(-2)), /violet release lane/);
	} finally {
		await worktree.close();
	}
});

test("Pi runner: bad JSON, model error and non-cooperating timeout still complete the turn", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	await new MemoryStore({ root: join(f.agentDir, "cc-memory/projects", resolveProjectIdentity(f.cwd).slug) }).upsert(write);
	for (const failure of ["json", "error", "timeout"] as const) {
		model.selector.output = failure === "json" ? "invalid JSON" : '{"files":["project:deploy.md"]}';
		model.selector.fail = failure === "error";
		model.selector.hang = failure === "timeout";
		const host = await openHost({ ...f, ...model, recall: true, timeoutMs: 30 });
		try {
			await host.session.prompt("部署流程？");
			assert.equal(host.session.getLastAssistantText(), "OK");
			assert.equal(readRecallUsage(host.context()).surfacedBytes, 0);
		} finally {
			await host.close();
		}
	}
});
