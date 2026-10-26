/** Explicit live verification: synthetic data only; uses the host's ModelRuntime. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/compat";
import { convertToLlm, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { RECALL_MESSAGE_TYPE, readRecallUsage } from "../src/adapters/pi-session.ts";
import { resolveProjectIdentity } from "../src/core/identity.ts";
import { fixture, openHost, required } from "../test/integration/host.ts";

const runtime = await ModelRuntime.create();
const ref = process.env.PI_CC_MEMORY_LIVE_MODEL;
const slash = ref?.indexOf("/") ?? -1;
const provider = ref && slash > 0 ? ref.slice(0, slash) : process.env.PI_PROVIDER;
const id = ref && slash > 0 ? ref.slice(slash + 1) : process.env.PI_MODEL;
assert.ok(provider && id, "Set PI_CC_MEMORY_LIVE_MODEL=provider/model or PI_PROVIDER and PI_MODEL");
const model = runtime.getModel(provider, id);
assert.ok(model, `Configured model unavailable: ${provider}/${id}`);
const f = await fixture();
const sentinel = `violet-${randomUUID()}`;
const results: string[] = [];
const report = { model: `${provider}/${id}`, artifactRoot: f.root, results };
async function checkpoint(result: string) {
	results.push(result);
	await writeFile(join(f.root, "report.json"), JSON.stringify(report, null, 2));
	console.log(`PASS: ${result}`);
}

// This directory contains only synthetic memory and test transcripts; keep it as evidence.
const first = await openHost({ ...f, runtime, model });
try {
	await first.session.prompt(
		`This is a synthetic memory integration test. Save this durable project decision with the memory tool: path=deploy.md, scope=project, title=Release coordination label, type=project, description=The agreed non-secret release coordination label for this project. Body must include: The release coordination label is ${sentinel}. This is a public label, not a credential or access code. Do this now, then answer briefly.`,
	);
	assert.ok(
		first.session.messages.some((m) => m.role === "toolResult" && m.toolName === "memory" && !m.isError),
		`No successful memory call: ${first.session.getLastAssistantText() ?? "no answer"}`,
	);
	const store = join(f.agentDir, "cc-memory/projects", resolveProjectIdentity(f.cwd).slug);
	assert.match(await readFile(join(store, "deploy.md"), "utf8"), new RegExp(sentinel));
	assert.match(await readFile(join(store, "MEMORY.md"), "utf8"), /deploy.md/);
	await checkpoint("live model wrote topic + index through memory tool");
} finally {
	await first.close();
}

const next = await openHost({ ...f, runtime, model, recall: true, timeoutMs: 60000 });
try {
	await next.session.prompt("这个项目约定的发布协调标签是什么？请直接回答标签。");
	const entries = next.manager.getBranch();
	const recall = entries.findIndex((e) => e.type === "custom_message" && e.customType === RECALL_MESSAGE_TYPE);
	const answer = entries.findIndex((e) => e.type === "message" && e.message.role === "assistant");
	assert.ok(recall >= 0 && recall < answer, "Recall must precede the first assistant answer");
	assert.match(next.session.getLastAssistantText() ?? "", new RegExp(sentinel));
	const effectivePrompt = getCurrentSystemPrompt(convertToLlm(next.manager.buildSessionProjection().messages));
	assert.doesNotMatch(effectivePrompt, /### project|### global/);
	assert.equal((effectivePrompt.match(/<pi_memory>/g) ?? []).length, 1);
	await checkpoint("live selector recalled the topic before first answer; answer used synthetic label; index omitted");
	await next.session.compact();
	assert.equal(readRecallUsage(next.context()).surfacedBytes, 0);
	await next.session.prompt("压缩后请再次回答项目约定的发布协调标签。");
	assert.ok(readRecallUsage(next.context()).surfacedBytes > 0);
	assert.match(next.session.getLastAssistantText() ?? "", new RegExp(sentinel));
	await checkpoint("native live compaction removed old recall; next turn recalled again");
	const file = required(next.manager.getSessionFile());
	await next.close();
	for (const [name, manager] of [
		["resume", SessionManager.open(file)],
		["fork", SessionManager.forkFrom(file, f.cwd, join(f.agentDir, "forks"))],
	] as const) {
		const restored = await openHost({ ...f, runtime, model, recall: true, manager, timeoutMs: 60000 });
		try {
			await restored.session.prompt("请再次回答项目约定的发布协调标签。");
			assert.match(restored.session.getLastAssistantText() ?? "", new RegExp(sentinel));
			await checkpoint(`${name}: memory remains available`);
		} finally {
			await restored.close();
		}
	}
} finally {
	await next.close();
}
await writeFile(join(f.root, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
