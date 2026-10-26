import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readSessionNote, SESSION_NOTE_ENTRY } from "../../src/adapters/session-note.ts";
import { fakeRuntime, fixture, openHost, required } from "./host.ts";

const command = (args: object) => `MEMORY_CALL ${JSON.stringify(args)}`;
const topic = {
	action: "write",
	path: "decision.md",
	scope: "project",
	title: "Decision",
	type: "project",
	description: "unique project hook",
	body: "Keep the violet lane.",
};

test("SDK forget returns a recovery id and another session restores exact content", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	const first = await openHost({ ...f, ...model });
	let id: string;
	try {
		await first.session.prompt(command(topic));
		await first.session.prompt(command({ action: "forget", path: "decision.md", scope: "project" }));
		const result = first.session.messages.at(-2);
		assert.ok(result?.role === "toolResult");
		id = (result.details as { recoveryId: string }).recoveryId;
		assert.ok(id);
	} finally {
		await first.close();
	}
	const second = await openHost({ ...f, ...model });
	try {
		await second.session.prompt(command({ action: "restore", recoveryId: id, scope: "project" }));
		await second.session.prompt(command({ action: "read", path: "decision.md", scope: "project" }));
		assert.match(JSON.stringify(second.session.messages.at(-2)), /Keep the violet lane/);
	} finally {
		await second.close();
	}
});

test("SDK uses updated project settings on the next call without restarting", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	const host = await openHost({ ...f, ...model });
	try {
		await host.session.prompt(command(topic));
		await mkdir(join(f.cwd, ".pi"));
		await writeFile(join(f.cwd, ".pi/settings.json"), JSON.stringify({ ccMemory: { indexLimits: { maxLines: 1 } } }));
		await host.session.prompt("Inspect the newly limited index.");
		assert.match(required(model.requests.at(-1)).prompt, /WARNING: MEMORY.md truncated/);
		assert.doesNotMatch(required(model.requests.at(-1)).prompt, /unique project hook/);
		await writeFile(join(f.cwd, ".pi/settings.json"), JSON.stringify({ ccMemory: { indexLimits: { maxLines: 200 } } }));
		await host.session.prompt("Inspect the restored index budget.");
		assert.match(required(model.requests.at(-1)).prompt, /unique project hook/);
	} finally {
		await host.close();
	}
});

test("SDK session note stays branch-scoped and augments native compaction without replacing it", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	let kept: string | undefined;
	const host = await openHost({
		...f,
		...model,
		extra: (pi) => {
			pi.on("session_before_compact", (event) => {
				kept = event.preparation.firstKeptEntryId;
			});
		},
	});
	try {
		await host.session.prompt("Ticket OPEN-47 remains unfinished; decision: use violet lane.");
		const branchPoint = required(host.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")).id;
		await host.session.prompt("Continue reviewing that unfinished ticket; nothing is complete yet.");
		await host.session.compact("Keep user-supplied compaction focus intact.");
		const note = required(readSessionNote(host.context()));
		assert.match(note.content, /OPEN-47/);
		// Native compaction can issue a history call followed by a turn-prefix
		// call. The continuity note belongs to the history input, not the last call.
		const summaryRequest = required(model.requests.find((request) => request.text.includes("<session-continuity-note>")));
		assert.match(summaryRequest.text, /session-continuity-note/);
		assert.match(summaryRequest.text, /OPEN-47/);
		assert.match(summaryRequest.text, /user-supplied compaction focus/);
		const compaction = host.manager.getBranch().find((entry) => entry.type === "compaction");
		assert.ok(compaction?.type === "compaction");
		assert.equal(compaction.firstKeptEntryId, kept);
		assert.equal(Boolean(compaction.fromHook), false);
		assert.ok(Array.isArray((compaction.details as { readFiles: string[] }).readFiles));
		assert.ok(host.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === SESSION_NOTE_ENTRY));
		assert.ok(
			!host.manager
				.buildSessionProjection()
				.messages.some((message) => message.role === "custom" && message.customType === SESSION_NOTE_ENTRY),
		);
		await host.session.prompt("/memory note");
		assert.ok(host.notifications.some((message) => message.includes("OPEN-47")));
		await host.session.navigateTree(branchPoint, { summarize: false });
		assert.equal(readSessionNote(host.context()), undefined);
		await host.session.prompt("Alternative branch.");
		const file = required(host.manager.getSessionFile());
		await host.close();
		const restored = await openHost({ ...f, ...model, manager: SessionManager.open(file) });
		try {
			assert.equal(readSessionNote(restored.context()), undefined);
		} finally {
			await restored.close();
		}
	} finally {
		await host.close();
	}
});

test("SDK native compaction still succeeds when note generation fails or times out", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	for (const kind of ["error", "timeout", "malformed"] as const) {
		model.note.fail = kind === "error";
		model.note.hang = kind === "timeout";
		model.note.output = "not a continuity note";
		const host = await openHost({ ...f, ...model, noteTimeoutMs: 20 });
		try {
			await host.session.prompt("Keep ticket OPEN-47 unfinished.");
			await host.session.compact();
			assert.equal(readSessionNote(host.context()), undefined);
			assert.ok(host.manager.getBranch().some((entry) => entry.type === "compaction"));
			assert.doesNotMatch(required(model.requests.at(-1)).text, /session-continuity-note/);
		} finally {
			await host.close();
		}
	}
});

test("SDK split-turn compaction keeps the note and its disabled setting avoids model work", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	for (const enabled of [true, false]) {
		await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ ccMemory: { sessionNote: { enabled } } }));
		const host = await openHost({ ...f, ...model });
		try {
			await host.session.prompt("Ticket OPEN-47 remains unfinished; decision: use violet lane.");
			const compacted = await host.session.compact();
			if (enabled) {
				assert.match(compacted.summary, /session-continuity-note/);
				assert.match(compacted.summary, /OPEN-47/);
			} else {
				assert.equal(readSessionNote(host.context()), undefined);
				assert.doesNotMatch(compacted.summary, /session-continuity-note/);
			}
		} finally {
			await host.close();
		}
	}
});

test("SDK automatic threshold compaction also receives session continuity", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const model = await fakeRuntime(f.root);
	const reasons: string[] = [];
	const host = await openHost({
		...f,
		...model,
		reserveTokens: 92000,
		extra: (pi) => {
			pi.on("session_compact", (event) => {
				reasons.push(event.reason);
			});
		},
	});
	try {
		await host.session.prompt(`${"Background context. ".repeat(2200)} Ticket OPEN-47 remains unfinished; use violet lane.`);
		host.session.settingsManager.setCompactionEnabled(true);
		await host.session.prompt("Continue the pending review.");
		assert.ok(reasons.includes("threshold"));
		assert.match(required(readSessionNote(host.context())).content, /OPEN-47/);
		assert.ok(host.manager.getBranch().some((entry) => entry.type === "compaction" && !entry.fromHook));
		assert.equal(host.session.getLastAssistantText(), "OK");
	} finally {
		await host.close();
	}
});
