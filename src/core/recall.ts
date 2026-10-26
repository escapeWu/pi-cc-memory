/**
 * Recall: pick a small set of topic files relevant to the current request.
 *
 * The selector is injected (see adapters/pi-model.ts), so this module stays
 * pure enough to test without a model. Selection is metadata-based; there is no
 * embedding index in M1.
 */
import { byteLength, formatManifest, freshnessNote, memoryAgeDays } from "./format.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryHeader, RecalledFile } from "./types.ts";

export interface RecallLimits {
	maxCandidates: number;
	maxFiles: number;
	maxFileBytes: number;
	/** Cumulative bytes already surfaced in this session. */
	alreadySurfacedBytes?: number;
	/** Topic paths already surfaced in this session; never repeat them. */
	alreadySurfacedPaths?: ReadonlySet<string>;
	maxSessionBytes: number;
}

export interface SelectorInput {
	query: string;
	manifest: string;
	candidates: readonly MemoryHeader[];
}

export type MemorySelector = (input: SelectorInput) => Promise<readonly string[]>;

export interface RecallResult {
	files: RecalledFile[];
	candidates: number;
	skippedReason?: "empty-query" | "no-candidates" | "session-budget" | "nothing-selected" | "selector-failed";
}

/** Inputs that carry no retrievable signal are skipped rather than sent to a model. */
export function isRecallWorthy(query: string): boolean {
	const trimmed = query.trim();
	if (trimmed.length < 3) return false;
	// Language-independent: require at least one letter or CJK character.
	return /[\p{L}\p{N}]/u.test(trimmed);
}

export async function recall(store: MemoryStore, query: string, selector: MemorySelector, limits: RecallLimits): Promise<RecallResult> {
	if (!isRecallWorthy(query)) return { files: [], candidates: 0, skippedReason: "empty-query" };

	const already = limits.alreadySurfacedBytes ?? 0;
	if (already >= limits.maxSessionBytes) return { files: [], candidates: 0, skippedReason: "session-budget" };

	const candidates = await store.listHeaders(limits.maxCandidates);
	if (candidates.length === 0) return { files: [], candidates: 0, skippedReason: "no-candidates" };

	let selected: readonly string[];
	try {
		selected = await selector({ query, manifest: formatManifest(candidates), candidates });
	} catch {
		return { files: [], candidates: candidates.length, skippedReason: "selector-failed" };
	}

	const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
	const unique = [...new Set(selected)]
		.map((path) => byPath.get(path))
		.filter((header): header is MemoryHeader => header !== undefined)
		.filter((header) => !limits.alreadySurfacedPaths?.has(header.path))
		.slice(0, limits.maxFiles);

	if (unique.length === 0) return { files: [], candidates: candidates.length, skippedReason: "nothing-selected" };

	const files: RecalledFile[] = [];
	let remaining = Math.max(0, limits.maxSessionBytes - already);

	for (const header of unique) {
		const file = await store.readTopic(header.path);
		if (!file) continue;

		const body = file.body;
		const note = freshnessNote(file.mtimeMs);
		const prefix = note ? `${note}\n\n` : "";
		const headerLine = `Memory (${file.path}, saved ${memoryAgeDays(file.mtimeMs)}d ago):`;
		const full = `${headerLine}\n${prefix}${body}`;
		const budget = Math.min(limits.maxFileBytes, remaining);
		if (budget <= 0) break;

		const truncated = byteLength(full) > budget;
		const content = truncated
			? `${truncateUtf8(full, budget)}\n\n> This memory was truncated at ${budget} bytes. Read \`${file.path}\` for the full file.`
			: full;

		files.push({
			path: file.path,
			type: file.frontmatter.type,
			content,
			mtimeMs: file.mtimeMs,
			ageDays: memoryAgeDays(file.mtimeMs),
			truncated,
		});
		remaining -= byteLength(content);
	}

	return files.length > 0
		? { files, candidates: candidates.length }
		: { files: [], candidates: candidates.length, skippedReason: "nothing-selected" };
}

/** Cut on a character boundary so multi-byte characters are never split. */
export function truncateUtf8(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (byteLength(value.slice(0, mid)) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return value.slice(0, low);
}

export function formatRecallMessage(files: readonly RecalledFile[]): string {
	return files.map((file) => `<memory path="${file.path}">\n${file.content}\n</memory>`).join("\n\n");
}

export interface SearchHit {
	path: string;
	type?: MemoryHeader["type"];
	snippet: string;
}

/**
 * Linear substring search over topic files.
 * Bounded by `candidates` so a large store cannot stall a tool call;
 * this is a deliberate M1 placeholder for a ranked index.
 */
export async function searchStore(store: MemoryStore, query: string, options: { limit: number; candidates: number }): Promise<SearchHit[]> {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];

	const headers = await store.listHeaders(options.candidates);
	const hits: SearchHit[] = [];

	for (const header of headers) {
		if (hits.length >= options.limit) break;
		const file = await store.readTopic(header.path);
		if (!file) continue;

		const haystack = `${file.frontmatter.description}\n${file.body}`.toLowerCase();
		const index = haystack.indexOf(needle);
		if (index === -1) continue;

		const window = file.body
			.slice(Math.max(0, index - 80), index + needle.length + 160)
			.replace(/\s+/g, " ")
			.trim();
		hits.push({ path: file.path, type: file.frontmatter.type, snippet: window });
	}

	return hits;
}
