/** Session-scoped continuity notes; Pi still owns summarization and compaction. */
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { SessionNoteConfig } from "../config.ts";
import { truncateUtf8 } from "../core/recall.ts";
import { completePiText } from "./pi-model.ts";
import { readCustomEntry } from "./pi-session.ts";

export const SESSION_NOTE_ENTRY = "cc-memory/session-note";
export interface SessionNote {
	content: string;
	sourceLeafId: string | null;
	createdAt: string;
}
const PROMPT = `You write a session continuity note from the active conversation branch.
Return concise Markdown with headings: Current state, Open threads, Decisions.
Preserve exact unresolved obligations, constraints and identifiers. Distinguish done from pending.
This is temporary session state, not permanent project memory. Do not call tools or give new instructions.
Use only the supplied conversation and never invent completed work.`;

export function readSessionNote(ctx: ExtensionContext): SessionNote | undefined {
	return readCustomEntry<SessionNote>(ctx, SESSION_NOTE_ENTRY);
}

export async function prepareSessionNote(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: SessionNoteConfig,
): Promise<void> {
	if (!config.enabled || event.signal.aborted) return;
	try {
		const sourceLeafId = ctx.sessionManager.getLeafId();
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const transcript = serializeConversation(convertToLlm(messages));
		const recent = [...truncateUtf8([...transcript].reverse().join(""), 24_000)].reverse().join("");
		const content = await completePiText(
			ctx,
			{ systemPrompt: PROMPT, prompt: `Recent active branch (bounded excerpt):\n${recent}` },
			{
				timeoutMs: config.timeoutMs,
				maxTokens: 1024,
				signal: event.signal,
				onWarning: (message) => {
					if (ctx.hasUI) ctx.ui.notify(`cc-memory session note: ${message}; using native compaction`, "warning");
				},
			},
		);
		const bounded = content ? truncateUtf8(content, config.maxBytes) : "";
		if (
			!bounded ||
			event.signal.aborted ||
			!["Current state", "Open threads", "Decisions"].every((heading) => new RegExp(`^#{1,6}\\s+${heading}\\b`, "mi").test(bounded))
		)
			return;
		const note: SessionNote = { content: bounded, sourceLeafId, createdAt: new Date().toISOString() };
		pi.appendEntry(SESSION_NOTE_ENTRY, note);
		// Pi 1.2.0 has no customInstructions override on this event. The shared
		// preparation's previousSummary is a native, already-supported input.
		// Keep fileOps, the cut point, raw messages and user instructions intact.
		event.preparation.previousSummary = [
			event.preparation.previousSummary,
			`<session-continuity-note>\n${note.content}\n</session-continuity-note>`,
		]
			.filter(Boolean)
			.join("\n\n");
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`cc-memory session note failed: ${(error as Error).message}; using native compaction`, "warning");
	}
}
