/** Read only this extension's namespace; never rewrite host settings. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isErrno } from "./filesystem.ts";

export function readMemorySettings(cwd: string, agentDir: string): { path: string; value: unknown }[] {
	return [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")].map((path) => {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) return { path, value: {} };
			throw new Error(`could not read Pi settings: ${path}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`invalid JSON in Pi settings: ${path}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Pi settings must be an object: ${path}`);
		return { path, value: "ccMemory" in parsed ? (parsed as Record<string, unknown>).ccMemory : {} };
	});
}
