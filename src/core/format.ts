/**
 * Markdown codec for memory files and the MEMORY.md index.
 *
 * Deliberately dependency-free: this is the format contract that survives a
 * host rewrite. It also fixes two issues inherited from the reference
 * implementation: index budgets are measured in real UTF-8 bytes, and paths
 * are validated before any filesystem call.
 */
import { type IndexEntry, MEMORY_TYPES, type MemoryFrontmatter, type MemoryHeader, type MemoryType } from "./types.ts";

export const INDEX_FILENAME = "MEMORY.md";
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 24_000;
export const TOPIC_MAX_BYTES = 32_768;

const FRONTMATTER_FENCE = "---";
const INDEX_ENTRY = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]\s*(.*))?$/;

export interface ParsedFrontmatter {
	data: Record<string, string>;
	body: string;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Parse the small YAML subset used by memory files: flat `key: value` pairs.
 * Missing or malformed frontmatter is not an error; it yields an empty map.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
	const text = raw.replace(/^\uFEFF/, "");
	const lines = text.split("\n");
	if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
		return { data: {}, body: text.trim() };
	}

	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === FRONTMATTER_FENCE) {
			end = i;
			break;
		}
	}
	if (end === -1) {
		return { data: {}, body: text.trim() };
	}

	const data: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon <= 0) continue;
		const key = trimmed.slice(0, colon).trim();
		const value = unquote(trimmed.slice(colon + 1));
		if (key) data[key] = value;
	}

	return {
		data,
		body: lines
			.slice(end + 1)
			.join("\n")
			.trim(),
	};
}

export function parseMemoryFrontmatter(data: Record<string, string>): MemoryFrontmatter {
	const { name = "", description = "", type, ...extra } = data;
	return {
		name,
		description,
		type: type === undefined ? "project" : isKnownType(type) ? type : "project",
		extra,
	};
}

function isKnownType(value: string): value is MemoryType {
	return (MEMORY_TYPES as readonly string[]).includes(value);
}

/** Parse one topic file. `raw` is the full file body; the path is relative. */
export function parseMemoryFile(
	path: string,
	raw: string,
	mtimeMs: number,
): { file: ReturnType<typeof buildMemoryFile>; warnings: string[] } {
	const warnings: string[] = [];
	const { data, body } = parseFrontmatter(raw);
	const frontmatter = parseMemoryFrontmatter(data);

	if (!data.type) warnings.push("missing frontmatter type; treated as project");
	else if (!isKnownType(data.type)) warnings.push(`unknown frontmatter type "${data.type}"; treated as project`);
	if (!data.description) warnings.push("missing frontmatter description; recall quality will suffer");
	if (!body.trim()) warnings.push("empty body");

	return { file: buildMemoryFile(path, frontmatter, body, mtimeMs), warnings };
}

function buildMemoryFile(path: string, frontmatter: MemoryFrontmatter, body: string, mtimeMs: number) {
	return { path, frontmatter, body, mtimeMs };
}

/** Serialize a topic file. Always writes all three frontmatter fields. */
export function serializeMemoryFile(input: { title: string; type: MemoryType; description: string; body: string }): string {
	const description = input.description.replace(/\s+/g, " ").trim();
	const name = input.title.replace(/\s+/g, " ").trim();
	const body = input.body.trim();
	return [FRONTMATTER_FENCE, `name: ${name}`, `description: ${description}`, `type: ${input.type}`, FRONTMATTER_FENCE, "", body, ""].join(
		"\n",
	);
}

/** Header parsing shared by recall and extraction. Reads only the frontmatter region. */
export function parseHeader(path: string, rawHead: string, mtimeMs: number): MemoryHeader {
	const { data } = parseFrontmatter(rawHead);
	const type = data.type && isKnownType(data.type) ? data.type : undefined;
	return {
		path,
		type,
		description: data.description || undefined,
		name: data.name || undefined,
		mtimeMs,
	};
}

/** One line per candidate: `[type] path (timestamp): description`. */
export function formatManifest(headers: readonly MemoryHeader[]): string {
	return headers
		.map((header) => {
			const tag = header.type ? `[${header.type}] ` : "";
			const stamp = new Date(header.mtimeMs).toISOString();
			return header.description ? `- ${tag}${header.path} (${stamp}): ${header.description}` : `- ${tag}${header.path} (${stamp})`;
		})
		.join("\n");
}

export function parseIndex(raw: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	const seen = new Set<string>();
	for (const line of raw.split("\n")) {
		const match = INDEX_ENTRY.exec(line);
		if (!match) continue;
		const title = match[1]?.trim() ?? "";
		const path = match[2]?.trim() ?? "";
		const hook = (match[3] ?? "").trim();
		if (!title || !path || seen.has(path)) continue;
		seen.add(path);
		entries.push({ title, path, hook });
	}
	return entries;
}

export function renderIndex(entries: readonly IndexEntry[]): string {
	const seen = new Set<string>();
	const lines: string[] = ["# Memory", ""];
	for (const entry of entries) {
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		const hook = entry.hook ? ` — ${entry.hook}` : "";
		lines.push(`- [${entry.title}](${entry.path})${hook}`);
	}
	lines.push("");
	return lines.join("\n");
}

export interface IndexTruncation {
	content: string;
	lineCount: number;
	byteCount: number;
	truncated: boolean;
}

/**
 * Enforce both the line and real UTF-8 byte budget.
 * Line truncation happens first, then a line-boundary byte cut.
 */
export function truncateIndex(raw: string, limits: { maxLines?: number; maxBytes?: number } = {}): IndexTruncation {
	const maxLines = limits.maxLines ?? INDEX_MAX_LINES;
	const maxBytes = limits.maxBytes ?? INDEX_MAX_BYTES;
	const trimmed = raw.trim();
	const lines = trimmed.split("\n");
	const lineCount = lines.length;
	const byteCount = byteLength(trimmed);

	let kept = lines;
	let truncated = false;

	if (lines.length > maxLines) {
		kept = lines.slice(0, maxLines);
		truncated = true;
	}

	let content = kept.join("\n");
	if (byteLength(content) > maxBytes) {
		const budget = [...kept];
		while (budget.length > 0 && byteLength(budget.join("\n")) > maxBytes) {
			budget.pop();
		}
		content = budget.join("\n");
		truncated = true;
	}

	if (truncated) {
		content += `\n\n> WARNING: ${INDEX_FILENAME} exceeded ${maxLines} lines or ${maxBytes} UTF-8 bytes. Only part of the index was loaded. Keep each entry to one line under ~150 characters and move detail into topic files.`;
	}

	return { content, lineCount, byteCount, truncated };
}

export function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** Normalize a hook so an index line stays one short line. */
export function normalizeHook(hook: string, maxChars = 150): string {
	const single = hook.replace(/\s+/g, " ").trim();
	if ([...single].length <= maxChars) return single;
	return `${[...single].slice(0, maxChars - 1).join("")}…`;
}

/**
 * Validate a topic path. Rejects absolute paths, traversal, hidden files and
 * non-Markdown targets so callers can pass model-generated paths safely.
 */
export function assertSafeTopicPath(path: string): string {
	if (!path || path.includes("\0")) throw new Error("memory path is empty or contains a null byte");
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
		throw new Error(`memory path must be relative: ${path}`);
	}
	const normalized = path.replace(/\\/g, "/");
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`memory path contains an invalid segment: ${path}`);
	}
	if (segments[0]?.startsWith(".")) throw new Error(`memory path must not target hidden files: ${path}`);
	if (!normalized.toLowerCase().endsWith(".md")) throw new Error(`memory path must end with .md: ${path}`);
	if (normalized.toLowerCase() === INDEX_FILENAME.toLowerCase()) {
		throw new Error("MEMORY.md is an index; update it through the memory store, not as a topic file");
	}
	return normalized;
}

/** Build a stable, readable topic filename from a title. */
export function topicPathFromTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return `${slug || "memory"}.md`;
}

export function memoryAgeDays(mtimeMs: number, now = Date.now()): number {
	return Math.max(0, Math.floor((now - mtimeMs) / 86_400_000));
}

/** Staleness note for memories older than one day. Empty for fresh files. */
export function freshnessNote(mtimeMs: number, now = Date.now()): string {
	const days = memoryAgeDays(mtimeMs, now);
	if (days <= 1) return "";
	return `This memory is ${days} days old. Memories are point-in-time observations, not live state. Verify file paths, function names and current behavior before asserting them as fact.`;
}
