/**
 * M3 placeholder: consolidate memories across sessions (merge, prune, re-index).
 *
 * Deliberately not implemented in M1. M3 must add:
 * - a time and session-count gate
 * - a store-level lock that serializes with explicit writes and extraction
 * - a prompt that merges into existing topics instead of creating near-duplicates
 */
import type { MemoryStore } from "../core/store.ts";

export interface ConsolidationOptions {
	store: MemoryStore;
	/** Hours since the last consolidation. */
	hoursSinceLastRun: number;
	/** Number of other sessions touched in that window. */
	sessionsTouched: number;
	minHours: number;
	minSessions: number;
	signal?: AbortSignal;
}

export interface ConsolidationOutcome {
	ran: boolean;
	reason?: string;
	filesTouched: string[];
}

export const CONSOLIDATION_MILESTONE = "M3";

export async function consolidate(_options: ConsolidationOptions): Promise<ConsolidationOutcome> {
	throw new Error("consolidate is planned for M3 (see docs/milestones.md); M1 has no background consolidation");
}
