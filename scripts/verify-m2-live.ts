/** Explicit M2 acceptance using only temporary, non-secret fixture data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readSessionNote } from "../src/adapters/session-note.ts";
import { resolveProjectIdentity } from "../src/core/identity.ts";
import { fixture, openHost, required } from "../test/integration/host.ts";

const ref = required(process.env.PI_CC_MEMORY_LIVE_MODEL);
const slash = ref.indexOf("/");
assert.ok(slash > 0);
const runtime = await ModelRuntime.create();
const model = required(runtime.getModel(ref.slice(0, slash), ref.slice(slash + 1)));
const f = await fixture();
console.log(`M2 evidence directory: ${f.root}`);
const label = `violet-${randomUUID()}`;
const ticket = `OPEN-${randomUUID()}`;
const store = join(f.agentDir, "cc-memory/projects", resolveProjectIdentity(f.cwd).slug);
const report = { model: ref, artifactRoot: f.root, results: [] as string[] };
async function pass(message: string) {
	report.results.push(message);
	await writeFile(join(f.root, "m2-report.json"), JSON.stringify(report, null, 2));
	console.log(`PASS: ${message}`);
}
const first = await openHost({ ...f, runtime, model, noteTimeoutMs: 60000 });
let original: string;
let recoveryId: string;
try {
	await first.session.prompt(
		`Save the agreed public release coordination label in project memory: path=decision.md, scope=project, title=Release label, type=project, description=Public release coordination label, body=The label is ${label}. This is non-secret fixture data. Use the memory tool now.`,
	);
	original = await readFile(join(store, "decision.md"), "utf8");
	assert.match(original, new RegExp(label));
	await pass("real model wrote a project topic");
	await first.session.prompt("Forget only project:decision.md with the memory tool and give its recovery id.");
	const receipt = first.session.messages.findLast(
		(m) => m.role === "toolResult" && m.toolName === "memory" && (m.details as { recoveryId?: string })?.recoveryId,
	);
	assert.ok(receipt?.role === "toolResult");
	recoveryId = required((receipt.details as { recoveryId: string }).recoveryId);
	await assert.rejects(readFile(join(store, "decision.md")), /ENOENT/);
	await pass("forget removed the topic and persisted a recovery receipt");
} finally {
	await first.close();
}
const second = await openHost({ ...f, runtime, model, noteTimeoutMs: 60000 });
try {
	await second.session.prompt(
		`Use memory action=restore, scope=project, recoveryId=${recoveryId}. Restore the deleted topic, then acknowledge.`,
	);
	assert.equal(await readFile(join(store, "decision.md"), "utf8"), original);
	assert.match(await readFile(join(store, "MEMORY.md"), "utf8"), /decision.md/);
	await pass("a new session restored exact bytes and the index via the real model");
	await second.session.prompt(
		`Current session working state: ticket ${ticket} is unfinished and must be reviewed next. Decision: use public label ${label}. Keep this temporary task in this session only; do not write it to persistent memory. Acknowledge briefly.`,
	);
	const compacted = await second.session.compact("Keep the exact unfinished ticket and release label; do not mark the ticket done.");
	const note = required(readSessionNote(second.context()));
	assert.match(note.content, new RegExp(ticket));
	assert.match(note.content, new RegExp(label));
	assert.match(compacted.summary, new RegExp(ticket));
	assert.match(compacted.summary, new RegExp(label));
	assert.ok(second.manager.getBranch().some((e) => e.type === "compaction" && !e.fromHook));
	await pass("bounded session note fed native compaction and preserved the exact pending ticket/decision");
	await second.session.prompt("What ticket remains unfinished, and what public release label was decided? Answer the exact identifiers.");
	const answer = second.session.getLastAssistantText() ?? "";
	assert.match(answer, new RegExp(ticket));
	assert.match(answer, new RegExp(label));
	await pass("after native compaction the real model still knows the unfinished work and decision");
} finally {
	await second.close();
}
console.log(JSON.stringify(report, null, 2));
