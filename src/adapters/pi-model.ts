/** Bounded provider calls through the host registry; no credential handling here. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemorySelector } from "../core/recall.ts";
import { truncateUtf8 } from "../core/recall.ts";

const SELECTOR_PROMPT = `You are selecting project memory files that will help with the user's current request.
You receive a query and a manifest, one file per line: [type] scope:path (timestamp): description.
Return scope-qualified paths exactly as listed. Only select clearly useful files.
Do not select tool usage documentation for a tool already used successfully.
Return JSON only: {"files":["project:path.md","global:other.md"]}.`;

function resolveModel(ctx: ExtensionContext, modelRef?: string) {
	if (modelRef) {
		const slash = modelRef.indexOf("/");
		return slash > 0 ? ctx.modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1)) : undefined;
	}
	return ctx.model ?? ctx.modelRegistry.getAvailable()[0];
}
export interface TextOptions {
	modelRef?: string;
	timeoutMs: number;
	maxTokens?: number;
	signal?: AbortSignal;
	onWarning?: (message: string) => void;
}

export async function completePiText(
	ctx: ExtensionContext,
	input: { systemPrompt: string; prompt: string },
	options: TextOptions,
): Promise<string | undefined> {
	const model = resolveModel(ctx, options.modelRef);
	if (!model) {
		options.onWarning?.("no model available for memory processing");
		return undefined;
	}
	const controller = new AbortController();
	const aborted = new Promise<never>((_resolve, reject) =>
		controller.signal.addEventListener("abort", () => reject(new Error("memory model call aborted")), { once: true }),
	);
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	const forward = () => controller.abort();
	const signals = [ctx.signal, options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
	for (const signal of signals) signal.addEventListener("abort", forward, { once: true });
	if (signals.some((signal) => signal.aborted)) controller.abort();
	try {
		if (controller.signal.aborted) await aborted;
		const response = await Promise.race([
			ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: input.systemPrompt,
					messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: input.prompt }] }],
				},
				{ maxTokens: options.maxTokens ?? 512, signal: controller.signal, cacheRetention: "none" },
			),
			aborted,
		]);
		if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") return undefined;
		return (
			response.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim() || undefined
		);
	} catch (error) {
		options.onWarning?.(
			controller.signal.aborted ? "memory model call timed out or was aborted" : `memory model call failed: ${(error as Error).message}`,
		);
		return undefined;
	} finally {
		clearTimeout(timer);
		for (const signal of signals) signal.removeEventListener("abort", forward);
	}
}

export interface SelectorOptions extends TextOptions {
	maxFiles?: number;
}
export function createPiSelector(ctx: ExtensionContext, options: SelectorOptions): MemorySelector {
	return async ({ query, manifest }) =>
		parseSelectedPaths(
			(await completePiText(
				ctx,
				{
					systemPrompt: `${SELECTOR_PROMPT}\nSelect at most ${options.maxFiles ?? 5} files.`,
					prompt: `Query:\n${truncateUtf8(query, 4000)}\n\nAvailable memory files:\n${manifest}`,
				},
				options,
			)) ?? "",
		).slice(0, options.maxFiles ?? 5);
}

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
	if (!parsed || typeof parsed !== "object") return [];
	const files = (parsed as { files?: unknown }).files;
	return Array.isArray(files) ? files.filter((value): value is string => typeof value === "string") : [];
}
export function describeModel(model: { provider?: string; id?: string }) {
	return { provider: String(model.provider ?? "unknown"), id: String(model.id ?? "unknown") };
}
