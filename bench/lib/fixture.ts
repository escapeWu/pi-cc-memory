/**
 * Materialise a Corpus as real project/global stores in a temp directory.
 *
 * Files and the index are written directly (same codec as production) because
 * MemoryStore.upsert takes a cross-process lock per call and would dominate
 * fixture time at thousands of topics. L1 measures upsert separately.
 * Never touches the user's real agent directory.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type MemoryConfig } from "../../src/config.ts";
import { normalizeHook, renderIndex, serializeMemoryFile } from "../../src/core/format.ts";
import { resolveProjectIdentity } from "../../src/core/identity.ts";
import type { RecallSource } from "../../src/core/recall.ts";
import { MemoryRouter } from "../../src/core/router.ts";
import type { MemoryScope } from "../../src/core/scopes.ts";
import { MemoryStore } from "../../src/core/store.ts";
import type { IndexEntry } from "../../src/core/types.ts";
import type { Corpus, TopicSpec } from "./corpus.ts";
import { mapPool } from "./stats.ts";

export interface Fixture {
	root: string;
	router: MemoryRouter;
	sources: RecallSource[];
	/** Production defaults, resolved through loadConfig with an empty environment. */
	config: MemoryConfig;
	topics: Map<string, TopicSpec>;
	cleanup(): Promise<void>;
}

const DAY_MS = 86_400_000;

export async function materialize(corpus: Corpus): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-cc-memory-bench-"));
	try {
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		const config = loadConfig(resolveProjectIdentity(cwd), {}, agentDir);

		const roots: Record<MemoryScope, string> = { project: config.storeRoot, global: config.global.root };
		const now = Date.now();
		const entries: Record<MemoryScope, IndexEntry[]> = { project: [], global: [] };
		await mkdir(roots.project, { recursive: true });
		await mkdir(roots.global, { recursive: true });

		await mapPool(corpus.topics, 32, async (topic) => {
			const path = join(roots[topic.scope], topic.path);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, serializeMemoryFile(topic));
			const mtime = new Date(now - topic.ageDays * DAY_MS);
			await utimes(path, mtime, mtime);
		});
		for (const topic of corpus.topics) {
			entries[topic.scope].push({ title: topic.title, path: topic.path, hook: normalizeHook(topic.description) });
		}
		for (const scope of ["project", "global"] as const) {
			await writeFile(join(roots[scope], "MEMORY.md"), renderIndex(entries[scope]));
		}

		const project = new MemoryStore({ root: roots.project, indexLimits: config.indexLimits, topicMaxBytes: config.topicMaxBytes });
		const global = new MemoryStore({ root: roots.global, indexLimits: config.indexLimits, topicMaxBytes: config.topicMaxBytes });
		const router = new MemoryRouter({ project, global, globalEnabled: corpus.options.globalEnabled, defaultScope: "project" });
		return {
			root,
			router,
			sources: router.sources(),
			config,
			topics: new Map(corpus.topics.map((topic) => [topic.key, topic])),
			cleanup: () => rm(root, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
