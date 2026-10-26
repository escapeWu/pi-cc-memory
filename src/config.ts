/** Per-call configuration: env > project Pi settings > global Pi settings > defaults. */
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readMemorySettings } from "./adapters/settings.ts";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES, TOPIC_MAX_BYTES } from "./core/format.ts";
import { expandUserPath, type ProjectIdentity } from "./core/identity.ts";
import type { MemoryScope } from "./core/scopes.ts";

export interface RecallConfig {
	enabled: boolean;
	maxCandidates: number;
	maxFiles: number;
	maxFileBytes: number;
	/** Bytes of recalls in effective model context, including their wrappers. */
	maxSessionBytes: number;
	modelRef?: string;
	timeoutMs: number;
}
export interface GlobalConfig {
	enabled: boolean;
	root: string;
	defaultScope: MemoryScope;
}
export interface SessionNoteConfig {
	enabled: boolean;
	maxBytes: number;
	timeoutMs: number;
}
export interface MemoryConfig {
	storeRoot: string;
	global: GlobalConfig;
	indexLimits: { maxLines: number; maxBytes: number };
	topicMaxBytes: number;
	recall: RecallConfig;
	sessionNote: SessionNoteConfig;
}
interface MemorySettings {
	global?: Partial<Pick<GlobalConfig, "enabled" | "defaultScope">>;
	indexLimits?: Partial<MemoryConfig["indexLimits"]>;
	topicMaxBytes?: number;
	recall?: Partial<RecallConfig>;
	sessionNote?: Partial<SessionNoteConfig>;
}
type Rule = "boolean" | "positive" | "scope" | "model" | { [key: string]: Rule };
const RULES: Record<string, Rule> = {
	global: { enabled: "boolean", defaultScope: "scope" },
	indexLimits: { maxLines: "positive", maxBytes: "positive" },
	topicMaxBytes: "positive",
	recall: {
		enabled: "boolean",
		maxCandidates: "positive",
		maxFiles: "positive",
		maxFileBytes: "positive",
		maxSessionBytes: "positive",
		modelRef: "model",
		timeoutMs: "positive",
	},
	sessionNote: { enabled: "boolean", maxBytes: "positive", timeoutMs: "positive" },
};

function validate(value: unknown, rule: Rule, field: string): void {
	if (typeof rule === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
		for (const [key, child] of Object.entries(value)) {
			const next = rule[key];
			if (!Object.hasOwn(rule, key) || !next)
				throw new Error(`${field}.${key} is not supported (store paths are configurable only through environment variables)`);
			validate(child, next, `${field}.${key}`);
		}
		return;
	}
	const valid =
		rule === "boolean"
			? typeof value === "boolean"
			: rule === "positive"
				? typeof value === "number" && Number.isSafeInteger(value) && value > 0
				: rule === "scope"
					? value === "project" || value === "global"
					: typeof value === "string" && (value === "" || /^[^/\s]+\/\S+$/.test(value));
	if (!valid)
		throw new Error(
			`${field} must be ${rule === "positive" ? "a positive safe integer" : rule === "scope" ? "project or global" : rule === "model" ? "provider/model (or empty for the session model)" : "a boolean"}`,
		);
}

function envValue(env: NodeJS.ProcessEnv, key: string, rule: Exclude<Rule, object>): unknown {
	const value = env[key];
	if (value === undefined || value === "") return undefined;
	let parsed: unknown = value;
	if (rule === "positive") parsed = Number(value);
	if (rule === "boolean") {
		const text = value.trim().toLowerCase();
		parsed = ["1", "true", "yes", "on"].includes(text) ? true : ["0", "false", "no", "off"].includes(text) ? false : value;
	}
	validate(parsed, rule, key);
	return parsed;
}

export function defaultStoreRoot(identity: ProjectIdentity, agentDir = getAgentDir()): string {
	return join(agentDir, "cc-memory", "projects", identity.slug);
}
export function defaultGlobalRoot(agentDir = getAgentDir()): string {
	return join(agentDir, "cc-memory", "global");
}

export function loadConfig(identity: ProjectIdentity, env: NodeJS.ProcessEnv = process.env, agentDir = getAgentDir()): MemoryConfig {
	const layers = readMemorySettings(identity.cwd, agentDir);
	for (const layer of layers) validate(layer.value, RULES, `${layer.path}: ccMemory`);
	const global = layers[0]?.value as MemorySettings;
	const project = layers[1]?.value as MemorySettings;
	const recall: RecallConfig = {
		enabled: false,
		maxCandidates: 200,
		maxFiles: 5,
		maxFileBytes: 4096,
		maxSessionBytes: 61440,
		timeoutMs: 8000,
		...global.recall,
		...project.recall,
	};
	const sessionNote: SessionNoteConfig = { enabled: true, maxBytes: 4096, timeoutMs: 8000, ...global.sessionNote, ...project.sessionNote };
	const indexLimits = { maxLines: INDEX_MAX_LINES, maxBytes: INDEX_MAX_BYTES, ...global.indexLimits, ...project.indexLimits };
	const globalConfig = { enabled: true, defaultScope: "project" as MemoryScope, ...global.global, ...project.global };
	const numberOverride = (key: string, fallback: number) => (envValue(env, key, "positive") as number | undefined) ?? fallback;
	const flagOverride = (key: string, fallback: boolean) => (envValue(env, key, "boolean") as boolean | undefined) ?? fallback;
	recall.enabled = flagOverride("PI_CC_MEMORY_RECALL", recall.enabled);
	for (const [key, name] of Object.entries({
		maxCandidates: "CANDIDATES",
		maxFiles: "FILES",
		maxFileBytes: "FILE_BYTES",
		maxSessionBytes: "SESSION_BYTES",
		timeoutMs: "TIMEOUT_MS",
	})) {
		const field = key as keyof Omit<RecallConfig, "enabled" | "modelRef">;
		recall[field] = numberOverride(`PI_CC_MEMORY_RECALL_${name}`, recall[field]);
	}
	recall.modelRef = (envValue(env, "PI_CC_MEMORY_RECALL_MODEL", "model") as string | undefined) ?? recall.modelRef;
	if (!recall.modelRef) delete recall.modelRef;
	sessionNote.enabled = flagOverride("PI_CC_MEMORY_SESSION_NOTE", sessionNote.enabled);
	sessionNote.maxBytes = numberOverride("PI_CC_MEMORY_SESSION_NOTE_BYTES", sessionNote.maxBytes);
	sessionNote.timeoutMs = numberOverride("PI_CC_MEMORY_SESSION_NOTE_TIMEOUT_MS", sessionNote.timeoutMs);
	globalConfig.enabled = flagOverride("PI_CC_MEMORY_GLOBAL", globalConfig.enabled);
	globalConfig.defaultScope =
		(envValue(env, "PI_CC_MEMORY_DEFAULT_SCOPE", "scope") as MemoryScope | undefined) ?? globalConfig.defaultScope;
	if (!globalConfig.enabled) globalConfig.defaultScope = "project";
	const pathOverride = (key: string, fallback: string) => {
		if (!env[key]) return fallback;
		const path = expandUserPath(env[key] ?? "");
		if (!path) throw new Error(`${key} must be an absolute path or ~/ path`);
		return path;
	};
	return {
		storeRoot: pathOverride("PI_CC_MEMORY_DIR", defaultStoreRoot(identity, agentDir)),
		global: { ...globalConfig, root: pathOverride("PI_CC_MEMORY_GLOBAL_DIR", defaultGlobalRoot(agentDir)) },
		recall,
		sessionNote,
		indexLimits: {
			maxLines: numberOverride("PI_CC_MEMORY_INDEX_LINES", indexLimits.maxLines),
			maxBytes: numberOverride("PI_CC_MEMORY_INDEX_BYTES", indexLimits.maxBytes),
		},
		topicMaxBytes: numberOverride("PI_CC_MEMORY_TOPIC_BYTES", project.topicMaxBytes ?? global.topicMaxBytes ?? TOPIC_MAX_BYTES),
	};
}
