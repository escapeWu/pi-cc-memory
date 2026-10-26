/**
 * Recall: pick a small set of topic files relevant to the current request.
 *
 * The selector is injected (see adapters/pi-model.ts), so this module stays pure
 * enough to test without a model. Selection is metadata-based; there is no
 * embedding index in M1.
 *
 * Candidates can come from both the project and the global store. Every
 * surfaced path is qualified with its scope so a fact is never attributed to the
 * wrong store.
 */
import { byteLength, formatManifest, freshnessNote, memoryAgeDays } from "./format.ts";
import { isMemoryScope, type MemoryScope } from "./scopes.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryHeader, RecalledFile } from "./types.ts";

export interface RecallSource {
	scope: MemoryScope;
	store: MemoryStore;
}

export interface RecallCandidate extends MemoryHeader {
	scope: MemoryScope;
}

export interface RecallLimits {
	maxCandidates: number;
	maxFiles: number;
	maxFileBytes: number;
	/** Cumulative bytes already surfaced in this session. */
	alreadySurfacedBytes?: number;
	/** `scope:path` keys already surfaced in this session; never repeat them. */
	alreadySurfacedPaths?: ReadonlySet<string>;
	maxSessionBytes: number;
}

export interface SelectorInput {
	query: string;
	manifest: string;
	candidates: readonly RecallCandidate[];
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

export function recallKey(scope: MemoryScope, path: string): string {
	return `${scope}:${path}`;
}

/** Manifest lines are qualified as `scope:path` so the selector can disambiguate. */
export function formatScopedManifest(candidates: readonly RecallCandidate[]): string {
	return formatManifest(candidates.map((candidate) => ({ ...candidate, path: recallKey(candidate.scope, candidate.path) })));
}

export async function recall(
	sources: readonly RecallSource[],
	query: string,
	selector: MemorySelector,
	limits: RecallLimits,
): Promise<RecallResult> {
	if (!isRecallWorthy(query)) return { files: [], candidates: 0, skippedReason: "empty-query" };

	const already = limits.alreadySurfacedBytes ?? 0;
	if (already >= limits.maxSessionBytes) return { files: [], candidates: 0, skippedReason: "session-budget" };

	// Gather per source, then keep the newest `maxCandidates` overall.
	const gathered: RecallCandidate[] = [];
	for (const source of sources) {
		const headers = await source.store.listHeaders(limits.maxCandidates);
		for (const header of headers) gathered.push({ ...header, scope: source.scope });
	}
	const candidates = gathered.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limits.maxCandidates);
	if (candidates.length === 0) return { files: [], candidates: 0, skippedReason: "no-candidates" };

	let selected: readonly string[];
	try {
		selected = await selector({ query, manifest: formatScopedManifest(candidates), candidates });
	} catch {
		return { files: [], candidates: candidates.length, skippedReason: "selector-failed" };
	}

	const byKey = new Map(candidates.map((candidate) => [recallKey(candidate.scope, candidate.path), candidate]));
	const project = new Map<string, RecallCandidate>();
	for (const candidate of candidates) {
		if (candidate.scope === "project" && !project.has(candidate.path)) project.set(candidate.path, candidate);
	}

	const seen = new Set<string>();
	const unique: RecallCandidate[] = [];
	for (const raw of selected) {
		const candidate = resolveSelection(raw, byKey, project);
		if (!candidate) continue;
		const key = recallKey(candidate.scope, candidate.path);
		if (seen.has(key) || limits.alreadySurfacedPaths?.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
		if (unique.length >= limits.maxFiles) break;
	}

	if (unique.length === 0) return { files: [], candidates: candidates.length, skippedReason: "nothing-selected" };

	const stores = new Map(sources.map((source) => [source.scope, source.store]));
	const files: RecalledFile[] = [];
	let remaining = Math.max(0, limits.maxSessionBytes - already);

	for (const candidate of unique) {
		const store = stores.get(candidate.scope);
		if (!store) continue;
		const file = await store.readTopic(candidate.path);
		if (!file) continue;

		const note = freshnessNote(file.mtimeMs);
		const prefix = note ? `${note}\n\n` : "";
		const headerLine = `Memory (${candidate.scope}:${file.path}, type ${file.frontmatter.type}, saved ${memoryAgeDays(file.mtimeMs)}d ago):`;
		const full = `${headerLine}\n${prefix}${file.body}`;
		// Include the serialized wrapper, separator and truncation notice in both
		// budgets; usage is reconstructed from this exact message after resume.
		const separatorBytes = files.length ? byteLength("\n\n") : 0;
		const budget = Math.min(limits.maxFileBytes, remaining - separatorBytes);
		const wrapperBytes = byteLength(formatRecallMessage([{ scope: candidate.scope, path: file.path, content: "" }]));
		const bodyBudget = budget - wrapperBytes;
		if (bodyBudget <= 0) continue;
		const truncated = byteLength(full) > bodyBudget;
		const notice = `\n\n> Truncated. Read ${recallKey(candidate.scope, file.path)} with the memory tool for the full file.`;
		if (truncated && byteLength(notice) >= bodyBudget) continue;
		const content = truncated ? `${truncateUtf8(full, bodyBudget - byteLength(notice))}${notice}` : full;

		files.push({
			scope: candidate.scope,
			path: file.path,
			type: file.frontmatter.type,
			content,
			mtimeMs: file.mtimeMs,
			ageDays: memoryAgeDays(file.mtimeMs),
			truncated,
		});
		remaining -= wrapperBytes + byteLength(content) + separatorBytes;
	}

	return files.length > 0
		? { files, candidates: candidates.length }
		: { files: [], candidates: candidates.length, skippedReason: "nothing-selected" };
}

/**
 * Accept `scope:path` first. A bare path resolves project-first, because a
 * project fact is the more specific answer for the same relative name.
 */
function resolveSelection(
	raw: string,
	byKey: ReadonlyMap<string, RecallCandidate>,
	project: ReadonlyMap<string, RecallCandidate>,
): RecallCandidate | undefined {
	const value = raw.trim();
	const direct = byKey.get(value);
	if (direct) return direct;

	const colon = value.indexOf(":");
	if (colon > 0) {
		const scope = value.slice(0, colon);
		const path = value.slice(colon + 1);
		if (isMemoryScope(scope)) return byKey.get(recallKey(scope, path));
	}

	return project.get(value) ?? byKey.get(recallKey("global", value));
}

/** Cut on a character boundary so multi-byte characters are never split. */
export function truncateUtf8(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	const chars = [...value];
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (byteLength(chars.slice(0, mid).join("")) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return chars.slice(0, low).join("");
}

export function formatRecallMessage(files: readonly Pick<RecalledFile, "scope" | "path" | "content">[]): string {
	return files.map((file) => `<memory scope="${file.scope}" path="${file.path}">\n${file.content}\n</memory>`).join("\n\n");
}

export interface SearchHit {
	path: string;
	type?: MemoryHeader["type"];
	snippet: string;
}

/**
 * Linear substring search over one store's topic files.
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

		const text = `${file.frontmatter.description}\n${file.body}`;
		const index = text.toLowerCase().indexOf(needle);
		if (index === -1) continue;

		const window = text
			.slice(Math.max(0, index - 80), index + needle.length + 160)
			.replace(/\s+/g, " ")
			.trim();
		hits.push({ path: file.path, type: file.frontmatter.type, snippet: window });
	}

	return hits;
}
