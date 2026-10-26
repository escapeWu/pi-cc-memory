/**
 * Filesystem adapter.
 *
 * Writes use temp file + rename inside the target directory. Store transactions
 * compose these helpers under the cross-process lock in store-lock.ts.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function readTextFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, { encoding: "utf8" });
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

/** Read at most `maxBytes` from the head of a file. Used for frontmatter scans. */
export async function readHead(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
		const truncated = bytesRead > maxBytes;
		return { text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"), truncated };
	} finally {
		await handle.close();
	}
}

export async function atomicWriteFile(path: string, content: string, mode = 0o600): Promise<void> {
	await ensureDir(dirname(path));
	const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
	await writeFile(temporary, content, { encoding: "utf8", mode });
	await rename(temporary, path);
}

export async function removeFile(path: string): Promise<boolean> {
	try {
		await unlink(path);
		return true;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	}
}

export async function removeTree(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

export async function fileMtimeMs(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

export async function listFilesRecursive(root: string): Promise<string[]> {
	const found: string[] = [];
	async function walk(directory: string, prefix: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".")) continue;
				await walk(join(directory, entry.name), relative);
			} else if (entry.isFile()) {
				found.push(relative);
			}
		}
	}
	await walk(root, "");
	return found;
}

/**
 * Resolve a relative topic path under `root`, rejecting escapes.
 * Lexical check only; symlink policy is applied separately by the store.
 */
export function resolveInside(root: string, relative: string): string {
	const rootAbs = resolve(root);
	const target = resolve(rootAbs, relative);
	if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
		throw new Error(`path escapes memory store: ${relative}`);
	}
	return target;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Minimal in-process mutex keyed by store root. Serializes read-modify-write
 * index updates so two concurrent tool calls cannot drop each other's entries.
 */
export class KeyedMutex {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release: () => void = () => {};
		const current = new Promise<void>((done) => {
			release = done;
		});
		const chained = previous.then(() => current);
		this.tails.set(key, chained);

		await previous;
		try {
			return await task();
		} finally {
			release();
			if (this.tails.get(key) === chained) this.tails.delete(key);
		}
	}
}
