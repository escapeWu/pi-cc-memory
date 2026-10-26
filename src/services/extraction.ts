/**
 * M3 placeholder: extract durable memories from new conversation turns.
 *
 * Deliberately not implemented in M1. The module exists so the boundary is
 * explicit and so M1 code never pretends automatic extraction is working.
 *
 * Planned contract (see docs/architecture.md):
 * - trigger after `agent_before_settle` when the run completed
 * - cursor stored via `appendEntry(EXTRACTION_CURSOR_ENTRY)`
 * - commit cursor only after a successful store write, never on tool_use alone
 * - single flight per session, latest context wins, one trailing run
 */
import type { MemoryStore } from "../core/store.ts";

export interface ExtractionContext {
	store: MemoryStore;
	/** Entry id the extraction has consumed up to. */
	cursor?: string;
	/** Plain-text transcript slice, already serialized by the caller. */
	transcript: string;
	signal?: AbortSignal;
}

export interface ExtractionOutcome {
	written: string[];
	skipped: boolean;
	reason?: string;
}

export const EXTRACTION_MILESTONE = "M3";

export async function extractMemories(_context: ExtractionContext): Promise<ExtractionOutcome> {
	throw new Error("extractMemories is planned for M3 (see docs/milestones.md); M1 does not extract in the background");
}
