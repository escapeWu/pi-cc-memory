import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completePiText, DEFAULT_MAX_TOKENS } from "../src/adapters/pi-model.ts";

type Reply = { stopReason: string; text?: string; errorMessage?: string };

function context(reasoning: boolean, reply: Reply) {
	const calls: Record<string, unknown>[] = [];
	const model = { provider: "p", id: "m", reasoning };
	const ctx = {
		model,
		signal: undefined,
		modelRegistry: {
			find: () => model,
			getAvailable: () => [model],
			streamSimple: (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
				calls.push(options);
				return {
					result: async () => ({
						stopReason: reply.stopReason,
						errorMessage: reply.errorMessage,
						content: reply.text === undefined ? [{ type: "thinking", thinking: "..." }] : [{ type: "text", text: reply.text }],
					}),
				};
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

const input = { systemPrompt: "s", prompt: "p" };

test("reasoning models get minimal effort and a budget that survives thinking", async () => {
	const { ctx, calls } = context(true, { stopReason: "stop", text: "ok" });
	assert.equal(await completePiText(ctx, input, { timeoutMs: 1000 }), "ok");
	assert.equal(calls[0]?.reasoning, "minimal");
	assert.equal(calls[0]?.maxTokens, DEFAULT_MAX_TOKENS);
	assert.ok(DEFAULT_MAX_TOKENS >= 2048);
});

test("non-reasoning models are not sent a reasoning option", async () => {
	const { ctx, calls } = context(false, { stopReason: "stop", text: "ok" });
	await completePiText(ctx, input, { timeoutMs: 1000, maxTokens: 300 });
	assert.equal("reasoning" in (calls[0] ?? {}), false);
	assert.equal(calls[0]?.maxTokens, 300);
});

test("an exhausted token budget is reported instead of failing silently", async () => {
	const warnings: string[] = [];
	const { ctx } = context(true, { stopReason: "length" });
	assert.equal(await completePiText(ctx, input, { timeoutMs: 1000, onWarning: (m) => warnings.push(m) }), undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /output tokens/);
});

test("a provider error is reported with its message", async () => {
	const warnings: string[] = [];
	const { ctx } = context(false, { stopReason: "error", errorMessage: "boom" });
	assert.equal(await completePiText(ctx, input, { timeoutMs: 1000, onWarning: (m) => warnings.push(m) }), undefined);
	assert.match(warnings[0] ?? "", /boom/);
});
