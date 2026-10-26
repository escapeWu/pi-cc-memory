import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ccMemory from "../src/extension.ts";

function fakePi() {
	const events: string[] = [];
	const tools: Record<string, unknown>[] = [];
	const commands: { name: string; options: Record<string, unknown> }[] = [];

	const pi = {
		on(event: string) {
			events.push(event);
			return () => {};
		},
		registerTool(tool: Record<string, unknown>) {
			tools.push(tool);
		},
		registerCommand(name: string, options: Record<string, unknown>) {
			commands.push({ name, options });
		},
	} as unknown as ExtensionAPI;

	return { pi, events, tools, commands };
}

describe("extension wiring", () => {
	test("registers the memory tool, command and lifecycle handlers", () => {
		const { pi, events, tools, commands } = fakePi();
		ccMemory(pi);

		assert.deepEqual(
			tools.map((tool) => tool.name),
			["memory"],
		);
		assert.deepEqual(
			commands.map((command) => command.name),
			["memory"],
		);
		assert.deepEqual(events.sort(), ["before_agent_start", "session_before_compact", "session_shutdown", "session_start"]);
	});

	test("exposes the documented tool actions", () => {
		const { pi, tools } = fakePi();
		ccMemory(pi);

		const params = tools[0]?.parameters as { properties?: Record<string, { enum?: string[] }> };
		assert.deepEqual(params.properties?.action?.enum, ["status", "list", "read", "write", "forget", "restore", "index", "search"]);
	});

	test("M3 services stay unimplemented so M1 cannot claim extraction", async () => {
		const { extractMemories } = await import("../src/services/extraction.ts");
		await assert.rejects(() => extractMemories({ store: {} as never, transcript: "" }), /M3/);

		const { consolidate } = await import("../src/services/consolidation.ts");
		await assert.rejects(
			() => consolidate({ store: {} as never, hoursSinceLastRun: 0, sessionsTouched: 0, minHours: 24, minSessions: 5 }),
			/M3/,
		);
	});
});
