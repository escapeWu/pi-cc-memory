/**
 * Model-facing memory policy.
 *
 * Written for this plugin rather than copied from the reference
 * implementation. It states the two storage tiers, requires an explicit scope,
 * and separates content type from routing.
 */
import { INDEX_FILENAME, INDEX_MAX_BYTES, INDEX_MAX_LINES } from "./format.ts";

export interface MemoryPolicyInput {
	/** Project store root. */
	projectRoot: string;
	/** Global store root; omitted when global memory is disabled. */
	globalRoot?: string;
	includeIndex: boolean;
	projectIndex?: string;
	globalIndex?: string;
	toolName?: string;
}

export function buildMemoryPolicy(input: MemoryPolicyInput): string {
	const tool = input.toolName ?? "memory";
	const globalEnabled = input.globalRoot !== undefined;

	const lines: string[] = [
		"# Memory",
		"",
		"This project has a persistent, file-based memory that survives sessions.",
		"",
		"## Two stores",
		"",
		`- \`project\` — \`${input.projectRoot}\``,
		"  Facts about this repository: goals, constraints, decisions and their rationale, external resources for this project.",
	];
	if (globalEnabled) {
		lines.push(
			`- \`global\` — \`${input.globalRoot}\``,
			"  Stable facts that apply across every project: who the user is, durable working preferences, and confirmed feedback about how to collaborate.",
			"  Shared by every project and every worktree.",
		);
	} else {
		lines.push("- `global` — disabled in this installation. Only the project store is available.");
	}
	lines.push(
		"",
		"## Scope is explicit",
		"",
		`Every \`${tool}\` write must choose a scope. Pass \`scope\` explicitly; when omitted, the configured default applies.`,
		"Type (`user`, `feedback`, `project`, `reference`) describes what a memory is about. It is not a routing rule.",
		"Use this as the default judgement: cross-project identity and preferences → `global`; repository facts and external pointers → `project`.",
		"Writing a project or reference fact to `global`, or a cross-project preference to `project`, is allowed but reported as a warning.",
		"",
		"## Types",
		"",
		"- `user` — stable facts about the person: role, expertise, working preferences.",
		"- `feedback` — guidance about how to work, including confirmed approaches. Lead with the rule, then **Why:** and **How to apply:**.",
		"- `project` — goals, constraints, decisions and their rationale that cannot be recovered from code or Git. Convert relative dates to absolute dates.",
		"- `reference` — where to find external resources: URLs, dashboards, trackers, service endpoints.",
		"",
		"## How to save",
		"",
		`Use the \`${tool}\` tool with action \`write\`. Give every memory a scope, a short title, one specific description, a type, and a body.`,
		"One topic per file. Before creating a file, check the index or search for an existing topic and update it instead.",
		`After a successful write, add or refresh its single-line pointer in that store's \`${INDEX_FILENAME}\` (action \`index\` with the same scope).`,
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
		`- Read the \`${INDEX_FILENAME}\` indexes for orientation; use \`${tool}\` action \`read\` with a scope, and action \`search\` for narrow terms.`,
		"- Memories are point-in-time observations. Before asserting a file, function, flag, or endpoint exists, verify it in the current workspace.",
		"- When a memory conflicts with current state, trust what you observe and update or forget the stale memory.",
		"- If asked to ignore memory, do not apply, cite, or compare against remembered content.",
		"",
		"## Forget",
		"",
		`Use action \`forget\` with the topic path and its scope. It removes the file and its index entry. Do not only append a correction that leaves the wrong claim in place.`,
	);

	if (input.includeIndex) {
		lines.push(
			"",
			`## ${INDEX_FILENAME}`,
			"",
			`The index is injected below. Each store has its own index, capped at ${INDEX_MAX_LINES} lines and ${INDEX_MAX_BYTES} UTF-8 bytes; keep entries to one line under ~150 characters.`,
			"",
			"### global",
			"",
			globalEnabled ? input.globalIndex?.trim() || `The global ${INDEX_FILENAME} is currently empty.` : "Global memory is disabled.",
			"",
			"### project",
			"",
			input.projectIndex?.trim() || `The project ${INDEX_FILENAME} is currently empty.`,
		);
	}

	return lines.join("\n");
}
