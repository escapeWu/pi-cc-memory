/**
 * Session adapter.
 *
 * Durable, non-context state lives in session entries so it follows the active
 * branch and survives resume. Recall usage is derived from previously injected
 * custom messages, which means compaction naturally resets the budget: the old
 * messages are no longer on the branch.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { byteLength } from "../core/format.ts";

export const EXTRACTION_CURSOR_ENTRY = "cc-memory/extraction-cursor";
export const RECALL_MESSAGE_TYPE = "cc-memory/recall";

export interface ExtractionCursor {
	/** Entry id after which memory extraction has already run. */
	entryId: string;
	at: number;
}

export interface RecallUsage {
	surfacedBytes: number;
	paths: Set<string>;
}

interface CustomMessageLike {
	type: "custom_message";
	customType: string;
	content: unknown;
	details?: unknown;
}

function isCustomMessage(entry: unknown): entry is CustomMessageLike {
	return typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "custom_message";
}

function contentLength(content: unknown): number {
	if (typeof content === "string") return byteLength(content);
	if (!Array.isArray(content)) return 0;
	return content.reduce((total, block) => {
		if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			return total + (typeof text === "string" ? byteLength(text) : 0);
		}
		return total;
	}, 0);
}

/** Read the newest custom entry of `customType` from the active branch. */
export function readCustomEntry<T>(ctx: ExtensionContext, customType: string): T | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "custom" && entry.customType === customType) {
			return entry.data as T;
		}
	}
	return undefined;
}

export function readExtractionCursor(ctx: ExtensionContext): ExtractionCursor | undefined {
	return readCustomEntry<ExtractionCursor>(ctx, EXTRACTION_CURSOR_ENTRY);
}

/**
 * Accumulate recall bytes and paths from the active branch.
 * Custom messages carry the surfaced paths in `details.paths`.
 */
export function readRecallUsage(ctx: ExtensionContext): RecallUsage {
	const paths = new Set<string>();
	let surfacedBytes = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isCustomMessage(entry) || entry.customType !== RECALL_MESSAGE_TYPE) continue;
		surfacedBytes += contentLength(entry.content);
		const details = entry.details;
		if (typeof details === "object" && details !== null) {
			const listed = (details as { paths?: unknown }).paths;
			if (Array.isArray(listed)) {
				for (const path of listed) {
					if (typeof path === "string") paths.add(path);
				}
			}
		}
	}

	return { surfacedBytes, paths };
}
