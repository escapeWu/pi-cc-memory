/**
 * Pi extension entry point.
 *
 * M1 wiring:
 * - session_start: resolve the project store and, when enabled, the global store
 * - before_agent_start: inject policy plus both indexes, optional recall
 * - memory tool: status / list / read / write / forget / index / search
 * - /memory: human-facing status summary
 *
 * Scope is explicit: `scope=global` targets the cross-project store, and fails
 * loudly when global memory is disabled instead of silently writing to the project.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiSelector } from "./adapters/pi-model.ts";
import { RECALL_MESSAGE_TYPE, readRecallUsage } from "./adapters/pi-session.ts";
import { loadConfig, type MemoryConfig } from "./config.ts";
import { type ProjectIdentity, resolveProjectIdentity } from "./core/identity.ts";
import { buildMemoryPolicy } from "./core/policy.ts";
import { formatRecallMessage, recall, recallKey } from "./core/recall.ts";
import { MemoryRouter } from "./core/router.ts";
import { isMemoryScope, MEMORY_SCOPES, type MemoryScope } from "./core/scopes.ts";
import { MemoryStore } from "./core/store.ts";
import { MEMORY_TYPES } from "./core/types.ts";

const TOOL_NAME = "memory";
const STATUS_KEY = "cc-memory";

interface SessionState {
	cwd: string;
	identity: ProjectIdentity;
	config: MemoryConfig;
	router: MemoryRouter;
}

const MemoryParams = Type.Object({
	action: StringEnum(["status", "list", "read", "write", "forget", "index", "search"] as const),
	scope: Type.Optional(
		StringEnum(MEMORY_SCOPES, {
			description: "Storage tier: global (cross-project) or project. Defaults to the configured scope.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Topic path relative to its store, e.g. feedback_testing.md" })),
	title: Type.Optional(Type.String({ description: "Short human-readable title (write)" })),
	type: Type.Optional(StringEnum(MEMORY_TYPES)),
	description: Type.Optional(Type.String({ description: "One specific line used to judge future relevance (write)" })),
	body: Type.Optional(Type.String({ description: "Memory content in Markdown (write)" })),
	query: Type.Optional(Type.String({ description: "Narrow search terms (search)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results (list/search), default 10" })),
});

export default function ccMemory(pi: ExtensionAPI): void {
	let session: SessionState | undefined;

	async function ensure(ctx: ExtensionContext): Promise<SessionState> {
		if (session && session.cwd === ctx.cwd) return session;
		const identity = resolveProjectIdentity(ctx.cwd);
		const config = loadConfig(identity);
		const limits = { indexLimits: config.indexLimits, topicMaxBytes: config.topicMaxBytes };
		const project = new MemoryStore({ root: config.storeRoot, ...limits });
		const global = new MemoryStore({ root: config.global.root, ...limits });

		const router = new MemoryRouter({
			project,
			global,
			globalEnabled: config.global.enabled,
			defaultScope: config.global.defaultScope,
		});
		await router.init();

		session = { cwd: ctx.cwd, identity, config, router };
		return session;
	}

	function statusText(state: SessionState, stats: Awaited<ReturnType<MemoryRouter["stats"]>>): string {
		const lines = [
			`project: ${state.identity.projectRoot}`,
			`project store: ${state.config.storeRoot} (${stats.project.topics} topics)`,
			`project index: ${stats.project.indexLines} lines, ${stats.project.indexBytes} bytes${stats.project.indexTruncated ? " (truncated)" : ""}`,
			stats.globalEnabled
				? `global store: ${state.config.global.root} (${stats.global?.topics ?? 0} topics)`
				: `global store: disabled${state.config.global.root ? ` (${state.config.global.root})` : ""}`,
			stats.globalEnabled
				? `global index: ${stats.global?.indexLines ?? 0} lines, ${stats.global?.indexBytes ?? 0} bytes${stats.global?.indexTruncated ? " (truncated)" : ""}`
				: "global index: not loaded",
			`default scope: ${state.router.defaultScope}`,
			`recall: ${state.config.recall.enabled ? "on" : "off"}`,
			`extraction: M3 (not wired)`,
		];
		return lines.join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const state = await ensure(ctx);
			const stats = await state.router.stats();
			if (ctx.hasUI) {
				const total = stats.project.topics + (stats.global?.topics ?? 0);
				ctx.ui.setStatus(STATUS_KEY, `memory ${total} topics`);
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`cc-memory: ${(error as Error).message}`, "warning");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = await ensure(ctx);
		const includeIndex = !state.config.recall.enabled;
		const indexes = includeIndex ? await state.router.readIndexes() : { project: "" };

		event.systemPromptOptions.sections = {
			...event.systemPromptOptions.sections,
			pi_memory: buildMemoryPolicy({
				projectRoot: state.config.storeRoot,
				...(state.router.globalEnabled ? { globalRoot: state.config.global.root } : {}),
				includeIndex,
				...(includeIndex ? { projectIndex: indexes.project } : {}),
				...(includeIndex && indexes.global !== undefined ? { globalIndex: indexes.global } : {}),
				toolName: TOOL_NAME,
			}),
		};

		if (!state.config.recall.enabled || event.messageType !== "user") return;

		const usage = readRecallUsage(ctx);
		const selector = createPiSelector(ctx, {
			...(state.config.recall.modelRef ? { modelRef: state.config.recall.modelRef } : {}),
			timeoutMs: state.config.recall.timeoutMs,
			onWarning: (message) => {
				if (ctx.hasUI) ctx.ui.notify(`cc-memory: ${message}`, "warning");
			},
		});

		const result = await recall(state.router.sources(), event.prompt, selector, {
			maxCandidates: state.config.recall.maxCandidates,
			maxFiles: state.config.recall.maxFiles,
			maxFileBytes: state.config.recall.maxFileBytes,
			maxSessionBytes: state.config.recall.maxSessionBytes,
			alreadySurfacedBytes: usage.surfacedBytes,
			alreadySurfacedPaths: usage.paths,
		});

		if (result.files.length === 0) return;

		return {
			message: {
				customType: RECALL_MESSAGE_TYPE,
				content: formatRecallMessage(result.files),
				display: false,
				details: { paths: result.files.map((file) => recallKey(file.scope, file.path)) },
			},
		};
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Project memory",
		description:
			"Read and maintain persistent Markdown memory. Scope=project holds repository facts; scope=global holds cross-project user identity and feedback. Actions: status, list, read, write, forget, index, search.",
		promptSnippet: "Persistent memory (project + global): list/read/search/write/forget/index",
		parameters: MemoryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = await ensure(ctx);
			const limit = Math.max(1, Math.min(50, params.limit ?? 10));
			const scope = optionalScope(params.scope);

			try {
				switch (params.action) {
					case "status": {
						const stats = await state.router.stats();
						return textResult(statusText(state, stats), {
							action: params.action,
							globalEnabled: stats.globalEnabled,
							project: stats.project,
							...(stats.global ? { global: stats.global } : {}),
						});
					}
					case "list": {
						const headers = await state.router.listHeaders(limit);
						const text = headers.length
							? headers
									.map((header) => `- [${header.scope}/${header.type ?? "?"}] ${header.path} — ${header.description ?? "(no description)"}`)
									.join("\n")
							: "No memories yet.";
						return textResult(text, { action: params.action, count: headers.length });
					}
					case "read": {
						if (!params.path) return errorResult("action=read requires path");
						const resolved = await state.router.read(params.path, scope);
						if (!resolved) return errorResult(`memory not found: ${params.path}${scope ? ` in scope=${scope}` : ""}`);
						return textResult(`${resolved.scope}:${resolved.file.path} [${resolved.file.frontmatter.type}]\n\n${resolved.file.body}`, {
							action: params.action,
							scope: resolved.scope,
							path: resolved.file.path,
							type: resolved.file.frontmatter.type,
						});
					}
					case "write": {
						if (!params.title || !params.type || !params.description || !params.body) {
							return errorResult("action=write requires title, type, description and body");
						}
						const result = await state.router.write({
							title: params.title,
							type: params.type,
							description: params.description,
							body: params.body,
							...(scope ? { scope } : {}),
							...(params.path ? { path: params.path } : {}),
						});
						const summary = `${result.created ? "Created" : "Updated"} ${result.scope}:${result.path}${result.indexUpdated ? " and updated the index" : ""}.`;
						const warnings = result.warnings.length ? `\n${result.warnings.join("\n")}` : "";
						return textResult(summary + warnings, { action: params.action, ...result });
					}
					case "forget": {
						if (!params.path) return errorResult("action=forget requires path");
						const result = await state.router.forget(params.path, scope);
						const extra = result.alsoExistsIn ? ` (the same path still exists in scope=${result.alsoExistsIn})` : "";
						return textResult(
							`${result.fileRemoved ? "Removed" : "No such file"}: ${result.scope}:${result.path}${result.indexUpdated ? "; index updated" : ""}${extra}`,
							{ action: params.action, ...result },
						);
					}
					case "index": {
						const indexes = await state.router.readIndexes();
						if (scope === "global") {
							return textResult(indexes.global?.trim() || "The global MEMORY.md is empty.", { action: params.action, scope: "global" });
						}
						if (scope === "project") {
							return textResult(indexes.project.trim() || "The project MEMORY.md is empty.", { action: params.action, scope: "project" });
						}
						const sections = [
							`# global\n\n${indexes.global?.trim() || (state.router.globalEnabled ? "empty" : "disabled")}`,
							`# project\n\n${indexes.project.trim() || "empty"}`,
						];
						return textResult(sections.join("\n\n"), { action: params.action, globalEnabled: state.router.globalEnabled });
					}
					case "search": {
						if (!params.query) return errorResult("action=search requires query");
						const hits = await state.router.search(params.query, {
							limit,
							candidates: state.config.recall.maxCandidates,
						});
						const filtered = scope ? hits.filter((hit) => hit.scope === scope) : hits;
						const text = filtered.length
							? filtered.map((hit) => `- ${hit.scope}:${hit.path} [${hit.type ?? "?"}]: ${hit.snippet}`).join("\n")
							: "No matching memories.";
						return textResult(text, { action: params.action, count: filtered.length });
					}
				}
			} catch (error) {
				return errorResult((error as Error).message);
			}
		},
	});

	pi.registerCommand("memory", {
		description: "Show memory status and topics for both stores",
		handler: async (args, ctx) => {
			const state = await ensure(ctx);
			const stats = await state.router.stats();

			if (args.trim() === "index") {
				const indexes = await state.router.readIndexes();
				const text = [
					`# global\n\n${indexes.global?.trim() || (state.router.globalEnabled ? "empty" : "disabled")}`,
					`# project\n\n${indexes.project.trim() || "empty"}`,
				].join("\n\n");
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				return;
			}

			const headers = await state.router.listHeaders(10);
			const topics = headers.length
				? headers.map((header) => `${header.scope}:${header.path} — ${header.description ?? "(no description)"}`).join("\n")
				: "No memories yet.";
			if (ctx.hasUI) ctx.ui.notify(`${statusText(state, stats)}\n\n${topics}`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		session = undefined;
	});
}

function optionalScope(value: string | undefined): MemoryScope | undefined {
	return isMemoryScope(value) ? value : undefined;
}

function textResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
}
