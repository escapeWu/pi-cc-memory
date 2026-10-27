/** Stable model-facing memory snapshots, persisted on the active Pi branch. */
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../config.ts";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES } from "../core/format.ts";
import { buildMemoryPolicy } from "../core/policy.ts";
import type { MemoryRouter } from "../core/router.ts";
import { readCustomEntry } from "./pi-session.ts";

export const PROMPT_SNAPSHOT_ENTRY = "cc-memory/prompt-snapshot";
interface PromptSnapshot {
	version: 1;
	key: string;
	compactionId: string | null;
	text: string;
}

function isSnapshot(value: unknown): value is PromptSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Partial<PromptSnapshot>;
	return (
		snapshot.version === 1 &&
		typeof snapshot.key === "string" &&
		(snapshot.compactionId === null || typeof snapshot.compactionId === "string") &&
		typeof snapshot.text === "string"
	);
}

/** Adopt the bytes already sent by older releases, only for a compatible policy. */
function legacyPolicy(ctx: ExtensionContext, emptyPolicy: string, config: MemoryConfig): string | undefined {
	// Older entries do not record their configured budgets. Only migrate the
	// default contract; an explicit budget change must take effect immediately.
	if (config.indexLimits.maxLines !== INDEX_MAX_LINES || config.indexLimits.maxBytes !== INDEX_MAX_BYTES) return;
	let section: string | null | undefined;
	for (const message of ctx.sessionManager.buildSessionProjection().messages) {
		if (message.role === "system" && message.sections && "pi_memory" in message.sections) section = message.sections.pi_memory;
	}
	if (typeof section !== "string") return;
	const text = section.startsWith("<pi_memory>\n") && section.endsWith("\n</pi_memory>") ? section.slice(12, -13) : section;
	if (config.recall.enabled) return text === emptyPolicy ? text : undefined;
	const marker = "\n## MEMORY.md\n";
	const prefix = emptyPolicy.slice(0, emptyPolicy.indexOf(marker) + marker.length);
	return text.startsWith(prefix) ? text : undefined;
}

/**
 * Ordinary writes never refresh this snapshot. The branch and successful
 * compaction id are read each time, so resume/fork/tree need no process cache.
 * Explicit authority-changing mutations call with refresh=true.
 */
export async function memoryPromptSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: MemoryConfig,
	router: MemoryRouter,
	refresh = false,
): Promise<string> {
	const input = {
		projectRoot: config.storeRoot,
		...(router.globalEnabled ? { globalRoot: config.global.root } : {}),
		includeIndex: !config.recall.enabled,
	};
	const emptyPolicy = buildMemoryPolicy(input);
	const key = createHash("sha256")
		.update(JSON.stringify([emptyPolicy, config.indexLimits]))
		.digest("hex");
	let compactionId: string | null = null;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "compaction") {
			compactionId = entry.id;
			break;
		}
	}
	const saved = readCustomEntry<unknown>(ctx, PROMPT_SNAPSHOT_ENTRY);
	if (!refresh && isSnapshot(saved) && saved.key === key && saved.compactionId === compactionId) return saved.text;

	let text = !refresh && saved === undefined ? legacyPolicy(ctx, emptyPolicy, config) : undefined;
	if (text === undefined) {
		const indexes = input.includeIndex ? await router.readIndexes() : undefined;
		text = buildMemoryPolicy({
			...input,
			...(indexes ? { projectIndex: indexes.project, globalIndex: indexes.global } : {}),
		});
	}
	const snapshot: PromptSnapshot = { version: 1, key, compactionId, text };
	pi.appendEntry(PROMPT_SNAPSHOT_ENTRY, snapshot);
	return text;
}
