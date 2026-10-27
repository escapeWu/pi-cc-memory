/**
 * Real model selector: the production `createPiSelector` against a model from
 * the host registry. The context shim exposes only what the selector touches
 * (model, modelRegistry.find/getAvailable/streamSimple, signal) and counts usage.
 * Sends synthetic benchmark data only; callers must opt in explicitly.
 */
import { type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiSelector } from "../../src/adapters/pi-model.ts";
import type { SelectorFactory, Usage } from "./selectors.ts";

type Response = Awaited<ReturnType<ReturnType<ModelRegistry["streamSimple"]>["result"]>>;

function wellFormed(text: string): boolean {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return false;
	try {
		return Array.isArray((JSON.parse(text.slice(start, end + 1)) as { files?: unknown }).files);
	} catch {
		return false;
	}
}

export async function liveFactory(options: { modelRef: string; timeoutMs: number; maxFiles: number }): Promise<SelectorFactory> {
	const slash = options.modelRef.indexOf("/");
	if (slash <= 0) throw new Error("model must be provider/model-id");
	const runtime = await ModelRuntime.create();
	const registry = new ModelRegistry(runtime);
	const model = registry.find(options.modelRef.slice(0, slash), options.modelRef.slice(slash + 1));
	if (!model) throw new Error(`model not available: ${options.modelRef}`);

	return () => {
		const usage: Usage = { calls: 0, input: 0, output: 0, degraded: 0 };
		const record = (response: Response) => {
			usage.calls++;
			usage.input += response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
			usage.output += response.usage.output;
			const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			if (response.stopReason !== "stop" || !wellFormed(text)) usage.degraded++;
		};
		const shim = {
			model,
			signal: undefined,
			modelRegistry: {
				find: (provider: string, id: string) => registry.find(provider, id),
				getAvailable: () => registry.getAvailable(),
				streamSimple: (...args: Parameters<ModelRegistry["streamSimple"]>) => {
					const stream = registry.streamSimple(...args);
					void stream.result().then(record, () => {});
					return stream;
				},
			},
		} as unknown as ExtensionContext;
		const selector = createPiSelector(shim, {
			timeoutMs: options.timeoutMs,
			maxFiles: options.maxFiles,
			// Warnings are only a signal here; `record` already classifies the response.
			onWarning: () => {
				usage.degraded++;
			},
		});
		return { selector, usage: () => ({ ...usage }) };
	};
}
