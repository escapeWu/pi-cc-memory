import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { canonicalRootFromGitEntry, findGitEntry, resolveProjectIdentity, sanitizeProjectSlug } from "../src/core/identity.ts";

const cleanups: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cc-memory-id-"));
	cleanups.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("identity", () => {
	test("produces distinct slugs for paths that sanitize alike", () => {
		assert.notEqual(sanitizeProjectSlug("/a/b-c"), sanitizeProjectSlug("/a-b/c"));
		assert.equal(sanitizeProjectSlug("/a/b"), sanitizeProjectSlug("/a/b"));
	});

	test("maps a linked worktree to the main repository root", async () => {
		const root = await tempDir();
		const main = join(root, "main");
		const gitDir = join(main, ".git");
		const worktree = join(root, "wt");

		await mkdir(join(gitDir, "worktrees", "wt"), { recursive: true });
		await mkdir(worktree, { recursive: true });
		await writeFile(join(gitDir, "worktrees", "wt", "commondir"), "../..\n");
		await writeFile(join(worktree, ".git"), `gitdir: ${join(gitDir, "worktrees", "wt")}\n`);

		const entry = findGitEntry(worktree);
		assert.equal(entry?.workingTree, worktree);
		assert.equal(canonicalRootFromGitEntry(entry?.gitPath ?? "", worktree), main);

		const identity = resolveProjectIdentity(worktree);
		assert.equal(identity.projectRoot, main);
	});

	test("falls back to the resolved cwd outside Git", async () => {
		const dir = await tempDir();
		const identity = resolveProjectIdentity(dir);
		assert.equal(identity.projectRoot, dir);
		assert.ok(identity.slug.length > 0);
	});
});
