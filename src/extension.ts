/**
 * Pi extension entry point.
 *
 * M1 wiring:
 * - session_start: resolve the project store
 * - before_agent_start: inject the memory policy (and index), optional recall
 * - memory tool: status / list / read / write / forget / index / search
 * - /memory: human-facing status summary
 *
 * No background extraction or consolidation is wired here; those are M3.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiSelector } from "./adapters/pi-model.ts";
import { RECALL_MESSAGE_TYPE, readRecallUsage } from "./adapters/pi-session.ts";
import { loadConfig, type MemoryConfig } from "./config.ts";
import { type ProjectIdentity, resolveProjectIdentity } from "./core/identity.ts";
import { buildMemoryPolicy } from "./core/policy.ts";
import { formatRecallMessage, recall, searchStore } from "./core/recall.ts";
import { MemoryStore } from "./core/store.ts";
import { MEMORY_TYPES } from "./core/types.ts";

const TOOL_NAME = "memory";
const STATUS_KEY = "cc-memory";

interface SessionState {
	cwd: string;
	identity: ProjectIdentity;
	config: MemoryConfig;
	store: MemoryStore;
}

const MemoryParams = Type.Object({
	action: StringEnum(["status", "list", "read", "write", "forget", "index", "search"] as const),
	path: Type.Optional(Type.String({ description: "Topic path relative to the memory store, e.g. feedback_testing.md" })),
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
		const store = new MemoryStore({
			root: config.storeRoot,
			indexLimits: config.indexLimits,
			topicMaxBytes: config.topicMaxBytes,
		});
		await store.init();
		session = { cwd: ctx.cwd, identity, config, store };
		return session;
	}

	function statusText(state: SessionState, stats: Awaited<ReturnType<MemoryStore["stats"]>>): string {
		return [
			`project: ${state.identity.projectRoot}`,
			`store: ${state.config.storeRoot}`,
			`topics: ${stats.topics}`,
			`index: ${stats.indexLines} lines, ${stats.indexBytes} bytes${stats.indexTruncated ? " (truncated)" : ""}`,
			`recall: ${state.config.recall.enabled ? "on" : "off"}`,
			`extraction: M3 (not wired)`,
		].join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const state = await ensure(ctx);
			const stats = await state.store.stats();
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `memory ${stats.topics} topics`);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`cc-memory: ${(error as Error).message}`, "warning");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = await ensure(ctx);
		const includeIndex = !state.config.recall.enabled;
		const indexContent = includeIndex ? await state.store.readIndex() : undefined;

		event.systemPromptOptions.sections = {
			...event.systemPromptOptions.sections,
			pi_memory: buildMemoryPolicy({
				storeRoot: state.config.storeRoot,
				includeIndex,
				...(indexContent !== undefined ? { indexContent } : {}),
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

		const result = await recall(state.store, event.prompt, selector, {
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
				details: { paths: result.files.map((file) => file.path) },
			},
		};
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Project memory",
		description:
			"Read and maintain the project's persistent Markdown memory. Use action=list to see topics, read/search to recall, write to save a durable fact, forget to remove a stale one, index to view or rebuild the MEMORY.md index.",
		promptSnippet: "Persistent project memory (list/read/search/write/forget/index)",
		parameters: MemoryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = await ensure(ctx);
			const limit = Math.max(1, Math.min(50, params.limit ?? 10));

			try {
				switch (params.action) {
					case "status": {
						const stats = await state.store.stats();
						return textResult(statusText(state, stats), { action: params.action, ...stats, root: state.config.storeRoot });
					}
					case "list": {
						const headers = await state.store.listHeaders(limit);
						const text = headers.length
							? headers.map((header) => `- [${header.type ?? "?"}] ${header.path} — ${header.description ?? "(no description)"}`).join("\n")
							: "No memories yet.";
						return textResult(text, { action: params.action, count: headers.length });
					}
					case "read": {
						if (!params.path) return errorResult("action=read requires path");
						const file = await state.store.readTopic(params.path);
						if (!file) return errorResult(`memory not found: ${params.path}`);
						return textResult(`${file.path} [${file.frontmatter.type}]\n\n${file.body}`, {
							action: params.action,
							path: file.path,
							type: file.frontmatter.type,
						});
					}
					case "write": {
						if (!params.title || !params.type || !params.description || !params.body) {
							return errorResult("action=write requires title, type, description and body");
						}
						const result = await state.store.upsert({
							title: params.title,
							type: params.type,
							description: params.description,
							body: params.body,
							...(params.path ? { path: params.path } : {}),
						});
						const summary = `${result.created ? "Created" : "Updated"} ${result.path}${result.indexUpdated ? " and updated the index" : ""}.`;
						const warnings = result.warnings.length ? `\n${result.warnings.join("\n")}` : "";
						return textResult(summary + warnings, { action: params.action, ...result });
					}
					case "forget": {
						if (!params.path) return errorResult("action=forget requires path");
						const result = await state.store.forget(params.path);
						return textResult(
							`${result.fileRemoved ? "Removed" : "No such file"}: ${result.path}${result.indexUpdated ? "; index updated" : ""}`,
							{ action: params.action, ...result },
						);
					}
					case "index": {
						const raw = await state.store.readIndex();
						return textResult(raw.trim() || "MEMORY.md is empty.", { action: params.action, path: "MEMORY.md" });
					}
					case "search": {
						if (!params.query) return errorResult("action=search requires query");
						const hits = await searchStore(state.store, params.query, {
							limit,
							candidates: state.config.recall.maxCandidates,
						});
						const text = hits.length
							? hits.map((hit) => `- ${hit.path} [${hit.type ?? "?"}]: ${hit.snippet}`).join("\n")
							: "No matching memories.";
						return textResult(text, { action: params.action, count: hits.length });
					}
				}
			} catch (error) {
				return errorResult((error as Error).message);
			}
		},
	});

	pi.registerCommand("memory", {
		description: "Show project memory status and topics",
		handler: async (args, ctx) => {
			const state = await ensure(ctx);
			const stats = await state.store.stats();

			if (args.trim() === "index") {
				const raw = await state.store.readIndex();
				if (ctx.hasUI) ctx.ui.notify(raw.trim() || "MEMORY.md is empty.", "info");
				return;
			}

			const headers = await state.store.listHeaders(10);
			const topics = headers.length
				? headers.map((header) => `${header.path} — ${header.description ?? "(no description)"}`).join("\n")
				: "No memories yet.";
			if (ctx.hasUI) ctx.ui.notify(`${statusText(state, stats)}\n\n${topics}`, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		session = undefined;
	});
}

function textResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
}
