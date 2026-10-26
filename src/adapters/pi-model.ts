/**
 * Pi model adapter for recall selection.
 *
 * Uses the host model registry so no provider credentials or SDK setup is
 * needed here. Selection is best-effort: a malformed response, missing model or
 * timeout degrades to "no recall" instead of failing the turn.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemorySelector } from "../core/recall.ts";
import { truncateUtf8 } from "../core/recall.ts";

const SELECTOR_PROMPT = `You are selecting project memory files that will help with the user's current request.

You receive a query and a manifest of memory files, one per line:
- [type] path (timestamp): description

Return up to 5 paths that are clearly useful for this request.
Rules:
- Only use paths listed in the manifest.
- Be selective. If nothing is clearly useful, return an empty list.
- Never select a file whose description is only usage documentation for a tool the user is already using successfully.
- Return JSON only: {"files": ["path.md"]}`;

interface CandidateModel {
	provider: string;
	id: string;
}

function resolveModel(ctx: ExtensionContext, modelRef?: string) {
	if (modelRef) {
		const slash = modelRef.indexOf("/");
		if (slash > 0) {
			const model = ctx.modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
			if (model) return model;
		}
	}
	if (ctx.model) return ctx.model;
	return ctx.modelRegistry.getAvailable()[0];
}

function describeModel(model: { provider?: string; id?: string }): CandidateModel {
	return { provider: String(model.provider ?? "unknown"), id: String(model.id ?? "unknown") };
}

export interface SelectorOptions {
	modelRef?: string;
	timeoutMs: number;
	/** Receives non-fatal diagnostics such as timeouts or unparseable output. */
	onWarning?: (message: string) => void;
}

export function createPiSelector(ctx: ExtensionContext, options: SelectorOptions): MemorySelector {
	const model = resolveModel(ctx, options.modelRef);

	return async ({ query, manifest }) => {
		if (!model) {
			options.onWarning?.("no model available for recall selection");
			return [];
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.timeoutMs);
		const forwardAbort = () => controller.abort();
		ctx.signal?.addEventListener("abort", forwardAbort, { once: true });

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							timestamp: Date.now(),
							content: [
								{
									type: "text",
									text: `Query:\n${truncateUtf8(query, 4000)}\n\nAvailable memory files:\n${manifest}`,
								},
							],
						},
					],
					systemPrompt: SELECTOR_PROMPT,
				},
				{ maxTokens: 512, signal: controller.signal, cacheRetention: "none" },
			);

			const text = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");

			return parseSelectedPaths(text);
		} catch (error) {
			const reason = controller.signal.aborted
				? "recall selection timed out or was aborted"
				: `recall selection failed: ${(error as Error).message}`;
			options.onWarning?.(reason);
			return [];
		} finally {
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", forwardAbort);
		}
	};
}

/** Extract the JSON object from a model response and validate its shape. */
export function parseSelectedPaths(text: string): string[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	const files = (parsed as { files?: unknown }).files;
	if (!Array.isArray(files)) return [];
	return files.filter((value): value is string => typeof value === "string").slice(0, 5);
}

export { describeModel };
