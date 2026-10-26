/** Versioned, immutable deletion receipts. No filesystem or Pi dependency. */
import { createHash, randomUUID } from "node:crypto";
import { assertSafeTopicPath } from "./format.ts";
import type { IndexEntry } from "./types.ts";

export interface RecoveryRecord {
	version: 1;
	id: string;
	path: string;
	content: string;
	deletedAt: string;
	sha256: string;
	indexEntry?: IndexEntry;
}

export function assertRecoveryId(id: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("invalid memory recovery id");
	return id;
}

function digest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function createRecovery(path: string, content: string, indexEntry?: IndexEntry): RecoveryRecord {
	return {
		version: 1,
		id: randomUUID(),
		path: assertSafeTopicPath(path),
		content,
		deletedAt: new Date().toISOString(),
		sha256: digest(content),
		...(indexEntry ? { indexEntry } : {}),
	};
}

export function parseRecovery(raw: string, id: string): RecoveryRecord {
	let record: RecoveryRecord;
	try {
		record = JSON.parse(raw);
	} catch {
		throw new Error("invalid memory recovery record JSON");
	}
	if (
		record?.version !== 1 ||
		record.id !== assertRecoveryId(id) ||
		typeof record.path !== "string" ||
		typeof record.content !== "string" ||
		typeof record.deletedAt !== "string" ||
		record.sha256 !== digest(record.content)
	) {
		throw new Error("invalid or damaged memory recovery record");
	}
	assertSafeTopicPath(record.path);
	if (
		record.indexEntry &&
		(record.indexEntry.path !== record.path || typeof record.indexEntry.title !== "string" || typeof record.indexEntry.hook !== "string")
	)
		throw new Error("invalid recovery index entry");
	return record;
}
