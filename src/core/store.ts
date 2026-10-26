/**
 * Memory store: the only owner of MEMORY.md and topic files.
 *
 * Invariants:
 * - A topic write and its index update happen under one in-process lock.
 * - Index entries always point at a topic that exists (best effort; a failed
 *   index write is reported, never silently swallowed).
 * - Paths from the model are validated before any filesystem call.
 */
import { lstat, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
	atomicWriteFile,
	ensureDir,
	fileMtimeMs,
	isErrno,
	KeyedMutex,
	listFilesRecursive,
	readHead,
	readTextFile,
	removeFile,
	resolveInside,
} from "../adapters/filesystem.ts";
import {
	assertSafeTopicPath,
	byteLength,
	INDEX_FILENAME,
	normalizeHook,
	parseHeader,
	parseIndex,
	parseMemoryFile,
	renderIndex,
	serializeMemoryFile,
	TOPIC_MAX_BYTES,
	topicPathFromTitle,
	truncateIndex,
} from "./format.ts";
import type { ForgetMemoryResult, IndexEntry, MemoryFile, MemoryHeader, WriteMemoryRequest, WriteMemoryResult } from "./types.ts";

const HEADER_READ_BYTES = 8192;
const lock = new KeyedMutex();

export interface MemoryStoreOptions {
	root: string;
	indexLimits?: { maxLines?: number; maxBytes?: number };
	topicMaxBytes?: number;
}

export class MemoryStore {
	readonly root: string;
	private readonly indexLimits: { maxLines?: number; maxBytes?: number };
	private readonly topicMaxBytes: number;

	constructor(options: MemoryStoreOptions) {
		this.root = resolve(options.root);
		this.indexLimits = options.indexLimits ?? {};
		this.topicMaxBytes = options.topicMaxBytes ?? TOPIC_MAX_BYTES;
	}

	get indexPath(): string {
		return join(this.root, INDEX_FILENAME);
	}

	async init(): Promise<void> {
		await ensureDir(this.root);
	}

	async readIndex(): Promise<string> {
		return (await readTextFile(this.indexPath)) ?? "";
	}

	async readIndexEntries(): Promise<IndexEntry[]> {
		return parseIndex(await this.readIndex());
	}

	/** Newest-first frontmatter headers, capped by `limit`. Excludes the index. */
	async listHeaders(limit = 200): Promise<MemoryHeader[]> {
		let files: string[];
		try {
			files = await listFilesRecursive(this.root);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return [];
			throw error;
		}

		const candidates = files.filter((path) => path.toLowerCase().endsWith(".md") && path !== INDEX_FILENAME);
		const headers = await Promise.all(
			candidates.map(async (path) => {
				const absolute = join(this.root, path);
				try {
					const [head, mtimeMs] = await Promise.all([readHead(absolute, HEADER_READ_BYTES), fileMtimeMs(absolute)]);
					return parseHeader(path, head.text, mtimeMs ?? 0);
				} catch {
					return undefined;
				}
			}),
		);

		return headers
			.filter((header): header is MemoryHeader => header !== undefined)
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, Math.max(0, limit));
	}

	/** Read one topic file with the path validated and symlinks rejected. */
	async readTopic(path: string): Promise<MemoryFile | undefined> {
		const relative = assertSafeTopicPath(path);
		const absolute = resolveInside(this.root, relative);
		await this.assertNoSymlinkEscape(absolute);

		const raw = await readTextFile(absolute);
		if (raw === undefined) return undefined;
		const mtimeMs = (await fileMtimeMs(absolute)) ?? 0;
		return parseMemoryFile(relative, raw, mtimeMs).file;
	}

	/**
	 * Create or replace a topic file and keep the index in sync.
	 * `path` is derived from the title unless explicitly supplied.
	 */
	async upsert(request: WriteMemoryRequest): Promise<WriteMemoryResult> {
		await this.init();
		const relative = request.path ? assertSafeTopicPath(request.path) : topicPathFromTitle(request.title);
		const absolute = resolveInside(this.root, relative);
		await this.assertNoSymlinkEscape(absolute);

		const content = serializeMemoryFile({
			title: request.title,
			type: request.type,
			description: request.description,
			body: request.body,
		});

		if (byteLength(content) > this.topicMaxBytes) {
			throw new Error(`memory topic exceeds ${this.topicMaxBytes} UTF-8 bytes; split it into smaller topic files`);
		}

		return lock.run(this.root, async () => {
			const created = (await fileMtimeMs(absolute)) === undefined;
			await atomicWriteFile(absolute, content);

			const warnings: string[] = [];
			let indexUpdated = false;
			try {
				const entries = await this.readIndexEntries();
				const next = upsertIndexEntry(entries, {
					title: request.title,
					path: relative,
					hook: normalizeHook(request.description),
				});
				await atomicWriteFile(this.indexPath, truncateIndex(renderIndex(next), this.indexLimits).content);
				indexUpdated = true;
			} catch (error) {
				warnings.push(`topic written but index update failed: ${(error as Error).message}`);
			}

			return { path: relative, created, indexUpdated, warnings };
		});
	}

	/** Remove a topic file and its index entry. */
	async forget(path: string): Promise<ForgetMemoryResult> {
		const relative = assertSafeTopicPath(path);
		const absolute = resolveInside(this.root, relative);
		await this.assertNoSymlinkEscape(absolute);
		await this.init();

		return lock.run(this.root, async () => {
			const fileRemoved = await removeFile(absolute);
			let indexUpdated = false;
			try {
				const entries = await this.readIndexEntries();
				const next = entries.filter((entry) => entry.path !== relative);
				if (next.length !== entries.length) {
					await atomicWriteFile(this.indexPath, truncateIndex(renderIndex(next), this.indexLimits).content);
					indexUpdated = true;
				}
			} catch {
				indexUpdated = false;
			}
			return { path: relative, fileRemoved, indexUpdated };
		});
	}

	/** Rebuild the index from disk. Useful after manual edits or partial writes. */
	async rebuildIndex(): Promise<{ entries: number; truncated: boolean }> {
		await this.init();
		return lock.run(this.root, async () => {
			const headers = await this.listHeaders(Number.MAX_SAFE_INTEGER);
			const entries: IndexEntry[] = headers.map((header) => ({
				title: header.name || header.path.replace(/\.md$/i, ""),
				path: header.path,
				hook: normalizeHook(header.description ?? ""),
			}));
			const truncated = truncateIndex(renderIndex(entries), this.indexLimits);
			await atomicWriteFile(this.indexPath, truncated.content);
			return { entries: entries.length, truncated: truncated.truncated };
		});
	}

	async stats(): Promise<{ topics: number; indexLines: number; indexBytes: number; indexTruncated: boolean }> {
		const headers = await this.listHeaders(Number.MAX_SAFE_INTEGER);
		const raw = await this.readIndex();
		const result = truncateIndex(raw, this.indexLimits);
		return {
			topics: headers.length,
			indexLines: result.lineCount,
			indexBytes: result.byteCount,
			indexTruncated: result.truncated,
		};
	}

	/**
	 * Reject a symlinked topic or one whose real path leaves the store.
	 * Prevents a link inside the store from exposing arbitrary files.
	 */
	private async assertNoSymlinkEscape(absolute: string): Promise<void> {
		try {
			const stats = await lstat(absolute);
			if (stats.isSymbolicLink()) throw new Error(`refusing to follow a symlinked memory path: ${absolute}`);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return;
			throw error;
		}

		const [realRoot, realTarget] = await Promise.all([realpath(this.root), realpath(absolute)]);
		const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
		if (realTarget !== realRoot && !realTarget.startsWith(rootPrefix)) {
			throw new Error(`memory path resolves outside the store: ${absolute}`);
		}
	}
}

function upsertIndexEntry(entries: readonly IndexEntry[], entry: IndexEntry): IndexEntry[] {
	const index = entries.findIndex((existing) => existing.path === entry.path);
	if (index === -1) return [...entries, entry];
	const next = [...entries];
	next[index] = entry;
	return next;
}

export { INDEX_FILENAME };
