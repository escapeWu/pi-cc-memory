/**
 * Configuration for one project store.
 *
 * Settings come from environment variables only in M1. A settings.json surface
 * is a later milestone; environment variables keep the skeleton host-agnostic
 * and easy to test.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES, TOPIC_MAX_BYTES } from "./core/format.ts";
import { expandUserPath, type ProjectIdentity } from "./core/identity.ts";
import type { MemoryScope } from "./core/scopes.ts";

export interface RecallConfig {
	/** When true, the index is not injected; relevant topic files are recalled instead. */
	enabled: boolean;
	/** Upper bound on frontmatter candidates considered per request. */
	maxCandidates: number;
	/** Maximum files surfaced per request. */
	maxFiles: number;
	/** Per-file byte cap when surfacing content. */
	maxFileBytes: number;
	/** Per-session cumulative byte budget for surfaced content. */
	maxSessionBytes: number;
	/** Optional `provider/model` used for relevance selection. Defaults to the session model. */
	modelRef?: string;
	/** Selection timeout. Exceeding it degrades to no recall rather than delaying the turn. */
	timeoutMs: number;
}

export interface GlobalConfig {
	/** When false, the global store is neither read nor written. */
	enabled: boolean;
	root: string;
	/** Scope used when a tool call omits `scope`. */
	defaultScope: MemoryScope;
}

export interface MemoryConfig {
	/** Absolute directory holding the project MEMORY.md and topic files. */
	storeRoot: string;
	global: GlobalConfig;
	indexLimits: { maxLines: number; maxBytes: number };
	topicMaxBytes: number;
	recall: RecallConfig;
}

const DEFAULT_RECALL: RecallConfig = {
	enabled: false,
	maxCandidates: 200,
	maxFiles: 5,
	maxFileBytes: 4096,
	maxSessionBytes: 60 * 1024,
	timeoutMs: 8000,
};

function envFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function envNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function defaultStoreRoot(identity: ProjectIdentity, agentDir = getAgentDir()): string {
	return join(agentDir, "cc-memory", "projects", identity.slug);
}

export function defaultGlobalRoot(agentDir = getAgentDir()): string {
	return join(agentDir, "cc-memory", "global");
}

export function loadConfig(identity: ProjectIdentity, env: NodeJS.ProcessEnv = process.env, agentDir = getAgentDir()): MemoryConfig {
	const override = env.PI_CC_MEMORY_DIR ? expandUserPath(env.PI_CC_MEMORY_DIR) : undefined;
	const storeRoot = override ?? defaultStoreRoot(identity, agentDir);

	const globalEnabled = envFlag(env.PI_CC_MEMORY_GLOBAL) ?? true;
	const globalOverride = env.PI_CC_MEMORY_GLOBAL_DIR ? expandUserPath(env.PI_CC_MEMORY_GLOBAL_DIR) : undefined;
	const requestedDefaultScope: MemoryScope = env.PI_CC_MEMORY_DEFAULT_SCOPE === "global" ? "global" : "project";

	const recall: RecallConfig = {
		...DEFAULT_RECALL,
		enabled: envFlag(env.PI_CC_MEMORY_RECALL) ?? DEFAULT_RECALL.enabled,
		maxCandidates: envNumber(env.PI_CC_MEMORY_RECALL_CANDIDATES) ?? DEFAULT_RECALL.maxCandidates,
		maxFiles: envNumber(env.PI_CC_MEMORY_RECALL_FILES) ?? DEFAULT_RECALL.maxFiles,
		maxFileBytes: envNumber(env.PI_CC_MEMORY_RECALL_FILE_BYTES) ?? DEFAULT_RECALL.maxFileBytes,
		maxSessionBytes: envNumber(env.PI_CC_MEMORY_RECALL_SESSION_BYTES) ?? DEFAULT_RECALL.maxSessionBytes,
		timeoutMs: envNumber(env.PI_CC_MEMORY_RECALL_TIMEOUT_MS) ?? DEFAULT_RECALL.timeoutMs,
	};
	if (env.PI_CC_MEMORY_RECALL_MODEL) recall.modelRef = env.PI_CC_MEMORY_RECALL_MODEL;

	return {
		storeRoot,
		global: {
			enabled: globalEnabled,
			root: globalOverride ?? defaultGlobalRoot(agentDir),
			// A disabled global store cannot be the default target.
			defaultScope: globalEnabled ? requestedDefaultScope : "project",
		},
		indexLimits: {
			maxLines: envNumber(env.PI_CC_MEMORY_INDEX_LINES) ?? INDEX_MAX_LINES,
			maxBytes: envNumber(env.PI_CC_MEMORY_INDEX_BYTES) ?? INDEX_MAX_BYTES,
		},
		topicMaxBytes: envNumber(env.PI_CC_MEMORY_TOPIC_BYTES) ?? TOPIC_MAX_BYTES,
		recall,
	};
}
