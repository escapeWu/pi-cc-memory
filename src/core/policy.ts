/**
 * Model-facing memory policy.
 *
 * Written for this plugin rather than copied from the reference
 * implementation: the wording is host-neutral, names this plugin's tool, and
 * states the invariants the store actually enforces.
 */
import { INDEX_FILENAME, INDEX_MAX_BYTES, INDEX_MAX_LINES } from "./format.ts";

export function buildMemoryPolicy(input: { storeRoot: string; includeIndex: boolean; indexContent?: string; toolName?: string }): string {
	const tool = input.toolName ?? "memory";
	const lines: string[] = [
		"# Project memory",
		"",
		`You have a persistent, file-based memory for this project at \`${input.storeRoot}\`.`,
		"It survives sessions and is shared by every worktree of this repository.",
		"",
		"## Types of memory",
		"",
		"- `user` — stable facts about the person: role, expertise, working preferences.",
		"- `feedback` — guidance about how to work, including confirmed approaches. Lead with the rule, then **Why:** and **How to apply:**.",
		"- `project` — goals, constraints, decisions and their rationale that cannot be recovered from code or Git. Convert relative dates to absolute dates.",
		"- `reference` — where to find external resources: URLs, dashboards, trackers, service endpoints.",
		"",
		"## How to save",
		"",
		`Use the \`${tool}\` tool with action \`write\`. Give every memory a short title, one specific description, a type, and a body.`,
		"One topic per file. Before creating a file, check the index or search for an existing topic and update it instead.",
		`After a successful write, add or refresh its single-line pointer in \`${INDEX_FILENAME}\` (action \`index\`). The index is navigation, never memory content.`,
		"",
		"## What not to save",
		"",
		"- Code structure, file paths, or architecture that can be derived by reading the repository.",
		"- Git history or commit contents; `git log` is authoritative.",
		"- Debugging narratives whose fix is already in the code.",
		"- Content already documented in project instruction files.",
		"- Ephemeral task state. Use the session or task system instead.",
		"- Secrets, credentials, tokens, or private keys.",
		"",
		"These exclusions hold even when explicitly asked to save. If asked to save an activity summary, ask what was surprising or non-obvious and keep only that.",
		"",
		"## How to recall",
		"",
		`- Read \`${INDEX_FILENAME}\` for orientation; use \`${tool}\` action \`read\` for a topic and action \`search\` for narrow terms.`,
		"- Memories are point-in-time observations. Before asserting a file, function, flag, or endpoint exists, verify it in the current workspace.",
		"- When a memory conflicts with current state, trust what you observe and update or forget the stale memory.",
		"- If asked to ignore memory, do not apply, cite, or compare against remembered content.",
		"",
		"## Forget",
		"",
		`Use action \`forget\` with the topic path. It removes the file and its index entry. Do not merely append a correction that leaves the wrong claim in place.`,
	];

	if (input.includeIndex) {
		lines.push(
			"",
			`## ${INDEX_FILENAME}`,
			"",
			`The index is injected below. It is capped at ${INDEX_MAX_LINES} lines and ${INDEX_MAX_BYTES} UTF-8 bytes; keep entries to one line under ~150 characters.`,
			"",
			input.indexContent?.trim() ? input.indexContent.trim() : `Your ${INDEX_FILENAME} is currently empty.`,
		);
	}

	return lines.join("\n");
}
