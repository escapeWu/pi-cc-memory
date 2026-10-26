import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	type ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-cc-memory-m1-"));
	const cwd = join(root, "project-a");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	return { root, cwd, agentDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function fakeRuntime(root: string) {
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const requests: { prompt: string; text: string }[] = [];
	const selector = { output: '{"files":["project:deploy.md"]}', fail: false, hang: false };
	runtime.registerProvider("memory-test", {
		api: "memory-test-api",
		apiKey: "test-only",
		baseUrl: "https://invalid.example",
		models: [
			{
				id: "fixture",
				name: "fixture",
				reasoning: false,
				input: ["text"],
				contextWindow: 100000,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const prompt = getCurrentSystemPrompt(context.messages);
				const text = JSON.stringify(context.messages);
				requests.push({ prompt, text });
				const selecting = prompt.includes("You are selecting project memory files");
				if (selecting && selector.hang) return;
				const last = context.messages.at(-1);
				const content = last && "content" in last ? last.content : "";
				const plain =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.filter((b) => b.type === "text")
									.map((b) => ("text" in b ? b.text : ""))
									.join("\n")
							: "";
				const command = /^MEMORY_CALL (.+)$/s.exec(plain);
				const output: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: command
						? [{ type: "toolCall", id: `call-${requests.length}`, name: "memory", arguments: JSON.parse(required(command[1])) }]
						: [{ type: "text", text: selecting ? selector.output : "OK" }],
					stopReason: selecting && selector.fail ? "error" : command ? "toolUse" : "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				if (selecting && selector.fail) {
					output.errorMessage = "fixture selector error";
					stream.push({ type: "error", reason: "error", error: output });
				} else stream.push({ type: "done", reason: command ? "toolUse" : "stop", message: output });
				stream.end();
			});
			return stream;
		},
	});
	const model = runtime.getModel("memory-test", "fixture");
	assert.ok(model);
	return { runtime, model, requests, selector };
}

export async function openHost(options: {
	cwd: string;
	agentDir: string;
	runtime: ModelRuntime;
	model: Model<Api>;
	manager?: SessionManager;
	recall?: boolean;
	global?: boolean;
	timeoutMs?: number;
	extra?: ExtensionFactory;
}) {
	const env = {
		PI_CODING_AGENT_DIR: options.agentDir,
		PI_CC_MEMORY_DIR: "",
		PI_CC_MEMORY_GLOBAL_DIR: "",
		PI_CC_MEMORY_DEFAULT_SCOPE: "project",
		PI_CC_MEMORY_GLOBAL: options.global === false ? "0" : "1",
		PI_CC_MEMORY_RECALL: options.recall ? "1" : "0",
		PI_CC_MEMORY_RECALL_MODEL: "",
		PI_CC_MEMORY_RECALL_TIMEOUT_MS: String(options.timeoutMs ?? 8000),
	};
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false } });
	let ctx: ExtensionContext;
	const notifications: string[] = [];
	const probe: ExtensionFactory = (pi) => {
		pi.on("session_start", (_event, context) => {
			ctx = context;
		});
	};
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../../src/extension.ts", import.meta.url))],
		extensionFactories: [probe, ...(options.extra ? [options.extra] : [])],
	});
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const manager = options.manager ?? SessionManager.create(options.cwd, join(options.agentDir, "sessions"));
		const { session } = await createAgentSession({
			cwd: options.cwd,
			agentDir: options.agentDir,
			modelRuntime: options.runtime,
			model: options.model,
			thinkingLevel: "off",
			tools: ["memory"],
			resourceLoader: loader,
			settingsManager,
			sessionManager: manager,
		});
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => {
				throw new Error(JSON.stringify(error));
			},
			uiContext: { notify: (message: string) => notifications.push(message), setStatus() {} } as never,
		});
		let closed = false;
		return {
			session,
			manager,
			notifications,
			context: () => required(ctx),
			async close() {
				if (closed) return;
				closed = true;
				await session.abort();
				session.dispose();
				for (const [key, value] of Object.entries(previous)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			},
		};
	} catch (error) {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		throw error;
	}
}

export function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "Required SDK evidence is missing");
	return value;
}

export const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export type { ModelRegistry };
