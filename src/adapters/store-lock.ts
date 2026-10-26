/** Local-filesystem store mutation lock, shared by all processes. */
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { ensureDir, isErrno, KeyedMutex } from "./filesystem.ts";

const local = new KeyedMutex();
// All writers must use the same heartbeat/stale policy.
const STALE_MS = 10_000;
const UPDATE_MS = 3000;

export async function withStoreLock<T>(root: string, task: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
	await ensureDir(root);
	const canonical = await realpath(root);
	return local.run(canonical, async () => {
		const path = join(canonical, ".store.lock");
		try {
			if ((await lstat(path)).isSymbolicLink()) throw new Error("refusing a symlinked memory store lock");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		let compromised: Error | undefined;
		let release: () => Promise<void>;
		try {
			release = await lock(canonical, {
				lockfilePath: path,
				stale: STALE_MS,
				update: UPDATE_MS,
				retries: { retries: Math.ceil(timeoutMs / 100), minTimeout: 100, maxTimeout: 100, factor: 1 },
				onCompromised(error) {
					compromised = error;
				},
			});
		} catch (error) {
			throw new Error(`memory store lock could not be acquired within ${timeoutMs}ms: ${canonical}`, { cause: error });
		}
		try {
			const result = await task();
			if (compromised) throw new Error("memory store lock was compromised; operation could not be confirmed", { cause: compromised });
			return result;
		} finally {
			await release();
		}
	});
}
