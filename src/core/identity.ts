/**
 * Project identity resolution.
 *
 * A memory store must be stable across worktrees of the same repository, and
 * distinct between unrelated checkouts even when their paths sanitize to the
 * same string. We therefore resolve the canonical Git working tree and append
 * a short content hash to the sanitized slug.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface ProjectIdentity {
	/** Working directory the session started in. */
	cwd: string;
	/** Canonical Git working tree, or the resolved cwd when not a repository. */
	projectRoot: string;
	/** Filesystem-safe, collision-resistant directory name. */
	slug: string;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readGitDirFile(path: string): string | undefined {
	try {
		const content = readFileSync(path, "utf8").trim();
		const match = /^gitdir:\s*(.+)$/i.exec(content);
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

/** Walk upward to the nearest `.git` entry (directory or worktree file). */
export function findGitEntry(start: string): { gitPath: string; workingTree: string } | undefined {
	let current = resolve(start);
	for (;;) {
		const candidate = join(current, ".git");
		if (existsSync(candidate)) {
			return { gitPath: candidate, workingTree: current };
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * Resolve the main repository working tree for a linked worktree.
 * `<main>/.git/worktrees/<name>` has a `commondir` file pointing back to
 * `<main>/.git`, whose parent is the main working tree.
 */
export function canonicalRootFromGitEntry(gitPath: string, workingTree: string): string {
	if (isDirectory(gitPath)) return workingTree;

	const gitDirRaw = readGitDirFile(gitPath);
	if (!gitDirRaw) return workingTree;

	const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(workingTree, gitDirRaw);
	const commonDirFile = join(gitDir, "commondir");
	if (!existsSync(commonDirFile)) {
		// Submodule or unusual layout: the git dir itself is authoritative enough.
		return basename(gitDir) === ".git" ? dirname(gitDir) : workingTree;
	}

	const commonRaw = readFileSync(commonDirFile, "utf8").trim();
	const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(gitDir, commonRaw);
	return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
}

/** `-Users-foo-repo-1a2b3c4d`: readable, filesystem-safe, collision-resistant. */
export function sanitizeProjectSlug(canonicalRoot: string): string {
	const normalized = resolve(canonicalRoot).split(sep).join("-");
	const readable = normalized.replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "");
	const prefix = readable.slice(0, 60) || "project";
	const hash = createHash("sha256").update(resolve(canonicalRoot)).digest("hex").slice(0, 8);
	return `${prefix}-${hash}`;
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
	const resolvedCwd = resolve(cwd);
	const gitEntry = findGitEntry(resolvedCwd);
	const root = gitEntry ? canonicalRootFromGitEntry(gitEntry.gitPath, gitEntry.workingTree) : resolvedCwd;
	// Git records physical paths. Normalize aliases (e.g. /var -> /private/var
	// on macOS) before hashing, or the main checkout and worktree diverge.
	const projectRoot = existsSync(root) ? realpathSync(root) : root;
	return { cwd: resolvedCwd, projectRoot, slug: sanitizeProjectSlug(projectRoot) };
}

/** Expand `~/`, then require an absolute path. Used for overrides. */
export function expandUserPath(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const expanded =
		trimmed === "~" || trimmed.startsWith(`~${sep}`) || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
	return isAbsolute(expanded) ? resolve(expanded) : undefined;
}
