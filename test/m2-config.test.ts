import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { resolveProjectIdentity } from "../src/core/identity.ts";
import { fixture } from "./integration/host.ts";

test("settings merge each field with env > project > global > defaults", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await mkdir(join(f.cwd, ".pi"));
	await writeFile(
		join(f.agentDir, "settings.json"),
		JSON.stringify({
			unrelated: "kept",
			ccMemory: {
				recall: { enabled: true, maxFiles: 3, maxFileBytes: 2000, modelRef: "provider/global" },
				global: { defaultScope: "global" },
			},
		}),
	);
	await writeFile(
		join(f.cwd, ".pi/settings.json"),
		JSON.stringify({ ccMemory: { recall: { maxFiles: 2, modelRef: "provider/project" }, sessionNote: { maxBytes: 3000 } } }),
	);
	const identity = resolveProjectIdentity(f.cwd);
	const config = loadConfig(identity, { PI_CC_MEMORY_RECALL_FILES: "1", PI_CC_MEMORY_GLOBAL: "0" }, f.agentDir);
	assert.equal(config.recall.enabled, true);
	assert.equal(config.recall.maxFiles, 1);
	assert.equal(config.recall.maxFileBytes, 2000);
	assert.equal(config.recall.modelRef, "provider/project");
	assert.equal(config.recall.maxSessionBytes, 61440);
	assert.equal(config.global.defaultScope, "project");
	assert.equal(config.sessionNote.maxBytes, 3000);
	assert.equal(config.sessionNote.enabled, true);
	assert.equal(config.topicMaxBytes, 32768);
	await writeFile(join(f.cwd, ".pi/settings.json"), JSON.stringify({ ccMemory: { recall: { enabled: false } } }));
	assert.equal(loadConfig(identity, {}, f.agentDir).recall.enabled, false);
});

test("invalid settings/env are readable errors and settings cannot redirect store paths", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const path = join(f.agentDir, "settings.json");
	const identity = resolveProjectIdentity(f.cwd);
	for (const setting of [
		{ storeRoot: "/etc" },
		{ global: { root: "/etc" } },
		{ recall: { enabled: "false" } },
		{ indexLimits: { maxBytes: -1 } },
		{ recall: { modelRef: "bad" } },
		{ sessionNote: { maxBytes: 0 } },
		null,
	]) {
		await writeFile(path, JSON.stringify({ ccMemory: setting }));
		assert.throws(() => loadConfig(identity, {}, f.agentDir), /ccMemory/);
	}
	await writeFile(path, "{bad-json");
	assert.throws(() => loadConfig(identity, {}, f.agentDir), /invalid JSON in Pi settings/);
	await writeFile(path, "{}");
	for (const env of [
		{ PI_CC_MEMORY_RECALL: "invalid" },
		{ PI_CC_MEMORY_RECALL_FILES: "1.2" },
		{ PI_CC_MEMORY_DEFAULT_SCOPE: "guess" },
		{ PI_CC_MEMORY_DIR: "relative" },
	]) {
		assert.throws(() => loadConfig(identity, env, f.agentDir), /PI_CC_MEMORY_/);
	}
});
