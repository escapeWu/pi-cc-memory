/**
 * Routes memory operations to the project store and, when enabled, the global
 * user store.
 *
 * Rules:
 * - Scope is explicit. The caller (tool input or configured default) picks it.
 * - Disabling global memory removes the global store entirely: reads and writes
 *   targeting it fail loudly instead of silently falling back to the project.
 * - Reads without a scope resolve project-first, then global. The resolved scope
 *   is always returned so callers never guess where a fact came from.
 */

import { type SearchHit, searchStore } from "./recall.ts";
import { type MemoryScope, typeScopeWarning } from "./scopes.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryFile, MemoryHeader, MemoryType, RecalledFile, WriteMemoryRequest } from "./types.ts";

export interface ScopedHeader extends MemoryHeader {
	scope: MemoryScope;
}

export interface ResolvedFile {
	scope: MemoryScope;
	file: MemoryFile;
}

export interface ScopedWriteResult {
	scope: MemoryScope;
	path: string;
	created: boolean;
	indexUpdated: boolean;
	warnings: string[];
}

export interface ScopedForgetResult {
	scope: MemoryScope;
	path: string;
	fileRemoved: boolean;
	indexUpdated: boolean;
	/** Present when the same relative path also exists in the other store. */
	alsoExistsIn?: MemoryScope;
}

export interface ScopedSearchHit extends SearchHit {
	scope: MemoryScope;
}

export interface RouterStats {
	project: { topics: number; indexLines: number; indexBytes: number; indexTruncated: boolean };
	global?: { topics: number; indexLines: number; indexBytes: number; indexTruncated: boolean };
	globalEnabled: boolean;
	defaultScope: MemoryScope;
}

export interface MemoryRouterOptions {
	project: MemoryStore;
	global?: MemoryStore;
	globalEnabled: boolean;
	defaultScope: MemoryScope;
}

export class MemoryRouter {
	readonly project: MemoryStore;
	readonly global: MemoryStore | undefined;
	readonly defaultScope: MemoryScope;

	constructor(options: MemoryRouterOptions) {
		this.project = options.project;
		this.global = options.globalEnabled ? options.global : undefined;
		this.defaultScope = options.defaultScope;
	}

	get globalEnabled(): boolean {
		return this.global !== undefined;
	}

	/** Resolve a scope to a store. Throws for `global` when it is disabled. */
	store(scope: MemoryScope): MemoryStore {
		if (scope === "project") return this.project;
		if (!this.global) {
			throw new Error("global memory is disabled (PI_CC_MEMORY_GLOBAL=0); retry with scope=project or enable global memory");
		}
		return this.global;
	}

	/** Project first, then global, for stable prompt ordering. */
	sources(): { scope: MemoryScope; store: MemoryStore }[] {
		const list: { scope: MemoryScope; store: MemoryStore }[] = [{ scope: "project", store: this.project }];
		if (this.global) list.push({ scope: "global", store: this.global });
		return list;
	}

	async init(): Promise<void> {
		await this.project.init();
		await this.global?.init();
	}

	async readIndexes(): Promise<{ project: string; global?: string }> {
		const project = await this.project.readIndex();
		if (!this.global) return { project };
		return { project, global: await this.global.readIndex() };
	}

	async stats(): Promise<RouterStats> {
		const project = await this.project.stats();
		const result: RouterStats = { project, globalEnabled: this.globalEnabled, defaultScope: this.defaultScope };
		if (this.global) result.global = await this.global.stats();
		return result;
	}

	/** Newest-first across both stores; ties keep project ahead of global. */
	async listHeaders(limit: number): Promise<ScopedHeader[]> {
		const merged: ScopedHeader[] = [];
		for (const { scope, store } of this.sources()) {
			const headers = await store.listHeaders(limit);
			for (const header of headers) merged.push({ ...header, scope });
		}
		return merged.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(0, limit));
	}

	async read(path: string, scope?: MemoryScope): Promise<ResolvedFile | undefined> {
		if (scope) {
			const file = await this.store(scope).readTopic(path);
			return file ? { scope, file } : undefined;
		}
		const project = await this.project.readTopic(path);
		if (project) return { scope: "project", file: project };
		if (!this.global) return undefined;
		const global = await this.global.readTopic(path);
		return global ? { scope: "global", file: global } : undefined;
	}

	async write(request: WriteMemoryRequest & { scope?: MemoryScope }): Promise<ScopedWriteResult> {
		const scope = request.scope ?? this.defaultScope;
		const store = this.store(scope);
		const warnings: string[] = [];
		const advisory = typeScopeWarning(request.type, scope);
		if (advisory) warnings.push(advisory);

		const result = await store.upsert(request);
		return { scope, ...result, warnings: [...warnings, ...result.warnings] };
	}

	async forget(path: string, scope?: MemoryScope): Promise<ScopedForgetResult> {
		const resolvedScope: MemoryScope = scope ?? (await this.detectScope(path)) ?? "project";
		const result = await this.store(resolvedScope).forget(path);

		const other: MemoryScope | undefined = resolvedScope === "project" ? (this.global ? "global" : undefined) : "project";
		let alsoExistsIn: MemoryScope | undefined;
		if (other && (await this.store(other).readTopic(path))) alsoExistsIn = other;

		return { scope: resolvedScope, ...result, ...(alsoExistsIn ? { alsoExistsIn } : {}) };
	}

	/** Project-first detection, matching `read()` without an explicit scope. */
	private async detectScope(path: string): Promise<MemoryScope | undefined> {
		if (await this.project.readTopic(path)) return "project";
		if (!this.global) return undefined;
		return (await this.global.readTopic(path)) ? "global" : undefined;
	}

	async search(query: string, options: { limit: number; candidates: number }): Promise<ScopedSearchHit[]> {
		const hits: ScopedSearchHit[] = [];
		for (const { scope, store } of this.sources()) {
			if (hits.length >= options.limit) break;
			const found = await searchStore(store, query, {
				limit: options.limit - hits.length,
				candidates: options.candidates,
			});
			for (const hit of found) hits.push({ ...hit, scope });
		}
		return hits.slice(0, options.limit);
	}
}

export type { MemoryType, RecalledFile };
