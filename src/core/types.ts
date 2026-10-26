/**
 * Content taxonomy for project memory.
 *
 * These are content categories, not storage scopes: every type can live in
 * either store. `user` describes the person; it never selects global routing.
 */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(value: unknown): value is MemoryType {
	return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

/** Frontmatter fields understood by this plugin. Unknown keys are preserved in `extra`. */
export interface MemoryFrontmatter {
	name: string;
	description: string;
	type: MemoryType;
	extra: Record<string, string>;
}

/** A parsed topic file. */
export interface MemoryFile {
	/** POSIX-style path relative to the store root. */
	path: string;
	frontmatter: MemoryFrontmatter;
	body: string;
	mtimeMs: number;
}

/** One line in MEMORY.md. The index is navigation, never memory content. */
export interface IndexEntry {
	title: string;
	path: string;
	hook: string;
}

/** Frontmatter-only view of a topic file, used for recall candidate lists. */
export interface MemoryHeader {
	path: string;
	type?: MemoryType;
	description?: string;
	name?: string;
	mtimeMs: number;
}

export interface WriteMemoryRequest {
	/** Explicit target path. Must be a `.md` file inside the store. */
	path?: string;
	title: string;
	type: MemoryType;
	description: string;
	body: string;
}

export interface WriteMemoryResult {
	path: string;
	created: boolean;
	indexUpdated: boolean;
	warnings: string[];
}

export interface ForgetMemoryResult {
	path: string;
	fileRemoved: boolean;
	indexUpdated: boolean;
	/** Present only when an existing topic was snapshotted before deletion. */
	recoveryId?: string;
}

export interface RestoreMemoryResult {
	path: string;
	recoveryId: string;
	indexUpdated: boolean;
	alreadyRestored: boolean;
}

import type { MemoryScope } from "./scopes.ts";

/** A topic surfaced to the model by the recall layer. */
export interface RecalledFile {
	/** Store the memory came from. */
	scope: MemoryScope;
	path: string;
	type?: MemoryType;
	content: string;
	mtimeMs: number;
	ageDays: number;
	truncated: boolean;
}
