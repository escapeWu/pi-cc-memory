/**
 * Selectors under test. All have the production `MemorySelector` shape, so
 * every one of them runs through the real `recall()` (candidate window,
 * resolution, budgets) and is scored on what recall() actually returns.
 */

import { type MemorySelector, recallKey, type SelectorInput, searchStore } from "../../src/core/recall.ts";
import type { QuerySpec } from "./corpus.ts";
import type { Fixture } from "./fixture.ts";

export type OfflineKind = "none" | "oracle" | "lexical" | "substring";
export type SelectorKind = OfflineKind | "llm";
export const OFFLINE_KINDS: readonly OfflineKind[] = ["none", "oracle", "lexical", "substring"];

export interface Usage {
	calls: number;
	input: number;
	output: number;
	/** Timeouts, model errors, or output that was not `{"files":[...]}`. */
	degraded: number;
}
export const NO_USAGE: Usage = { calls: 0, input: 0, output: 0, degraded: 0 };

export interface SelectorHandle {
	selector: MemorySelector;
	usage(): Usage;
}
export type SelectorFactory = (query: QuerySpec) => SelectorHandle;

const keysOf = (input: SelectorInput) => input.candidates.map((c) => recallKey(c.scope, c.path));
const stateless = (selector: MemorySelector): SelectorHandle => ({ selector, usage: () => NO_USAGE });

const STOP = new Set(
	"the a an of for is are was what to i me my need remind and in on how do does can please this that it with from at by about who whom when which".split(
		" ",
	),
);

/** Latin words plus CJK character bigrams; stop words dropped. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const piece of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (!piece) continue;
		if (/\p{Script=Han}/u.test(piece)) {
			const han = [...piece].filter((ch) => /\p{Script=Han}/u.test(ch));
			for (let i = 0; i + 1 < han.length; i++) out.push(han[i] + (han[i + 1] ?? ""));
			for (const word of piece.split(/\p{Script=Han}+/u)) if (word && !STOP.has(word)) out.push(word);
		} else if (!STOP.has(piece)) out.push(piece);
	}
	return out;
}

/**
 * Cheap non-LLM baseline: IDF-weighted token overlap against the manifest
 * fields the real selector sees (name, description, path). Keeps results within
 * 40% of the best score so it does not always return top-k.
 */
export function lexicalSelect(input: SelectorInput, maxFiles: number): string[] {
	const docs = input.candidates.map((c) => ({
		key: recallKey(c.scope, c.path),
		tokens: new Set(tokenize(`${c.name ?? ""} ${c.description ?? ""} ${c.path.replace(/\.md$/, "").replace(/[-_/]/g, " ")}`)),
	}));
	const df = new Map<string, number>();
	for (const doc of docs) for (const token of doc.tokens) df.set(token, (df.get(token) ?? 0) + 1);
	const query = new Set(tokenize(input.query));
	const scored = docs
		.map((doc) => {
			let score = 0;
			for (const token of query) if (doc.tokens.has(token)) score += Math.log((docs.length + 1) / ((df.get(token) ?? 0) + 0.5)) + 1;
			return { key: doc.key, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score);
	const top = scored[0]?.score ?? 0;
	return scored
		.filter((entry) => entry.score >= top * 0.4)
		.slice(0, maxFiles)
		.map((entry) => entry.key);
}

export function offlineFactory(kind: OfflineKind, fixture: Fixture, maxFiles: number, maxCandidates: number): SelectorFactory {
	return (query) => {
		switch (kind) {
			case "none":
				return stateless(async () => []);
			case "oracle":
				return stateless(async (input) => {
					const window = new Set(keysOf(input));
					return query.gold.filter((key) => window.has(key));
				});
			case "lexical":
				return stateless(async (input) => lexicalSelect(input, maxFiles));
			case "substring":
				// Production `search` semantics: the whole prompt is one substring needle.
				return stateless(async () => {
					const keys: string[] = [];
					for (const source of fixture.sources) {
						const hits = await searchStore(source.store, query.text, { limit: maxFiles, candidates: maxCandidates });
						for (const hit of hits) keys.push(recallKey(source.scope, hit.path));
					}
					return keys;
				});
		}
	};
}
