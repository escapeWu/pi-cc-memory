import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { resolveProjectIdentity } from "../src/core/identity.ts";
import { buildMemoryPolicy } from "../src/core/policy.ts";
import { MemoryRouter } from "../src/core/router.ts";
import { typeScopeWarning } from "../src/core/scopes.ts";
import { MemoryStore } from "../src/core/store.ts";

const cleanups: string[] = [];

async function tempRoot(prefix = "cc-memory-router-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(dir);
	return dir;
}

async function routerFor(options: { global: boolean; defaultScope?: "project" | "global" }): Promise<MemoryRouter> {
	const base = await tempRoot();
	const project = new MemoryStore({ root: join(base, "project") });
	const global = new MemoryStore({ root: join(base, "global") });
	const router = new MemoryRouter({
		project,
		global,
		globalEnabled: options.global,
		defaultScope: options.defaultScope ?? "project",
	});
	await router.init();
	return router;
}

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("two-tier routing", () => {
	test("writes to the store named by scope, not by type", async () => {
		const router = await routerFor({ global: true });

		const globalWrite = await router.write({
			scope: "global",
			title: "Language",
			type: "user",
			description: "answer in Chinese",
			body: "The user asks in Chinese.",
		});
		const projectWrite = await router.write({
			scope: "project",
			title: "Deploy",
			type: "project",
			description: "deploy flow",
			body: "Deploys run from the release branch.",
		});
		// A user fact explicitly routed to project stays in project.
		const projectScopedPreference = await router.write({
			scope: "project",
			title: "Repo tooling",
			type: "user",
			description: "uses pnpm here",
			body: "Use pnpm in this repository.",
		});

		assert.equal(globalWrite.scope, "global");
		assert.equal(projectWrite.scope, "project");
		assert.equal(projectScopedPreference.scope, "project");
		assert.deepEqual((await router.global?.readTopic("language.md"))?.path, "language.md");
		assert.equal(await router.project.readTopic("language.md"), undefined);
		assert.ok(await router.project.readTopic("repo-tooling.md"));
		assert.equal(await router.global?.readTopic("repo-tooling.md"), undefined);
	});

	test("warns when type and scope suggest different tiers, without blocking", async () => {
		const router = await routerFor({ global: true });

		const result = await router.write({
			scope: "global",
			title: "Repo note",
			type: "project",
			description: "repo specific",
			body: "This should probably be project-scoped.",
		});

		assert.equal(result.created, true);
		assert.match(result.warnings.join("\n"), /usually belong to the project store/);
		assert.ok(await router.global?.readTopic("repo-note.md"));
	});

	test("uses the configured default scope when the tool omits it", async () => {
		const router = await routerFor({ global: true, defaultScope: "global" });
		const result = await router.write({ title: "Tone", type: "feedback", description: "terse", body: "Prefer terse answers." });
		assert.equal(result.scope, "global");
	});

	test("read without scope resolves project before global", async () => {
		const router = await routerFor({ global: true });
		await router.write({ scope: "project", path: "shared.md", title: "P", type: "project", description: "p", body: "project body" });
		await router.write({ scope: "global", path: "shared.md", title: "G", type: "user", description: "g", body: "global body" });

		const resolved = await router.read("shared.md");
		assert.equal(resolved?.scope, "project");
		assert.match(resolved?.file.body ?? "", /project body/);

		const explicit = await router.read("shared.md", "global");
		assert.equal(explicit?.scope, "global");
		assert.match(explicit?.file.body ?? "", /global body/);
	});

	test("forget reports when the same path also exists in the other store", async () => {
		const router = await routerFor({ global: true });
		await router.write({ scope: "project", path: "dup.md", title: "P", type: "project", description: "p", body: "p" });
		await router.write({ scope: "global", path: "dup.md", title: "G", type: "user", description: "g", body: "g" });

		const result = await router.forget("dup.md");
		assert.equal(result.scope, "project");
		assert.equal(result.fileRemoved, true);
		assert.equal(result.alsoExistsIn, "global");
		assert.ok(await router.global?.readTopic("dup.md"));
	});

	test("disabling global removes it from injection, listing and recall", async () => {
		const router = await routerFor({ global: false });
		await router.write({ scope: "project", title: "Local", type: "project", description: "local", body: "local" });

		assert.equal(router.globalEnabled, false);
		assert.deepEqual(
			router.sources().map((source) => source.scope),
			["project"],
		);
		assert.deepEqual(
			(await router.listHeaders(10)).map((header) => header.scope),
			["project"],
		);

		const indexes = await router.readIndexes();
		assert.equal(indexes.global, undefined);
	});

	test("a global write fails loudly while global is disabled", async () => {
		const router = await routerFor({ global: false });
		await assert.rejects(
			router.write({ scope: "global", title: "X", type: "user", description: "x", body: "x" }),
			/global memory is disabled/,
		);
		await assert.rejects(router.read("anything.md", "global"), /global memory is disabled/);
		await assert.rejects(router.forget("anything.md", "global"), /global memory is disabled/);
	});

	test("search spans both stores and labels the origin", async () => {
		const router = await routerFor({ global: true });
		await router.write({ scope: "project", title: "Deploy", type: "project", description: "deploy", body: "release branch" });
		await router.write({ scope: "global", title: "Editor", type: "user", description: "editor", body: "nvim keybindings" });

		const hits = await router.search("release", { limit: 10, candidates: 50 });
		assert.deepEqual(
			hits.map((hit) => `${hit.scope}:${hit.path}`),
			["project:deploy.md"],
		);
	});
});

describe("scope policy text", () => {
	test("type mismatch advice is advisory text only", () => {
		assert.match(typeScopeWarning("user", "project") ?? "", /usually cross-project/);
		assert.match(typeScopeWarning("project", "global") ?? "", /usually belong to the project store/);
		assert.equal(typeScopeWarning("user", "global"), undefined);
		assert.equal(typeScopeWarning("project", "project"), undefined);
	});

	test("policy names both stores when global is enabled and marks it disabled otherwise", () => {
		const enabled = buildMemoryPolicy({ projectRoot: "/p", globalRoot: "/g", includeIndex: true, projectIndex: "p", globalIndex: "g" });
		assert.match(enabled, /Two stores/);
		assert.match(enabled, /Scope is explicit/);
		assert.match(enabled, /### global\n\ng/);
		assert.match(enabled, /### project\n\np/);

		const disabled = buildMemoryPolicy({ projectRoot: "/p", includeIndex: false });
		assert.match(disabled, /disabled in this installation/);
	});
});

describe("config", () => {
	test("global defaults on and can be disabled", () => {
		const identity = resolveProjectIdentity("/tmp/pi-cc-memory-config");
		const on = loadConfig(identity, {} as NodeJS.ProcessEnv, "/agent");
		const off = loadConfig(identity, { PI_CC_MEMORY_GLOBAL: "0" } as NodeJS.ProcessEnv, "/agent");

		assert.equal(on.global.enabled, true);
		assert.equal(on.global.root, "/agent/cc-memory/global");
		assert.equal(off.global.enabled, false);
	});

	test("a disabled global store cannot be the default scope", () => {
		const identity = resolveProjectIdentity("/tmp/pi-cc-memory-config");
		const config = loadConfig(
			identity,
			{ PI_CC_MEMORY_GLOBAL: "false", PI_CC_MEMORY_DEFAULT_SCOPE: "global" } as NodeJS.ProcessEnv,
			"/agent",
		);
		assert.equal(config.global.defaultScope, "project");
	});

	test("default scope and global dir are configurable", () => {
		const identity = resolveProjectIdentity("/tmp/pi-cc-memory-config");
		const config = loadConfig(
			identity,
			{ PI_CC_MEMORY_DEFAULT_SCOPE: "global", PI_CC_MEMORY_GLOBAL_DIR: "/custom/global" } as NodeJS.ProcessEnv,
			"/agent",
		);
		assert.equal(config.global.defaultScope, "global");
		assert.equal(config.global.root, "/custom/global");
	});
});
