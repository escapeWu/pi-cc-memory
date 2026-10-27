/** Result files and console tables shared by every benchmark layer. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Metric = number | string | null;
export interface Row {
	/** Stable identity used by compare.ts, e.g. `size=400 sel=lexical slice=all`. */
	label: string;
	metrics: Record<string, Metric>;
}
export interface BenchResult {
	name: string;
	startedAt: string;
	env: { node: string; platform: string; cpu: string; commit: string; dirty: boolean };
	params: Record<string, unknown>;
	rows: Row[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function git(args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

export function environment(): BenchResult["env"] {
	return {
		node: process.version,
		platform: `${platform()} ${process.arch}`,
		cpu: cpus()[0]?.model ?? "unknown",
		commit: git(["rev-parse", "--short", "HEAD"]) || "unknown",
		dirty: git(["status", "--porcelain", "--", "src", "bench"]) !== "",
	};
}

export function newResult(name: string, params: Record<string, unknown>): BenchResult {
	return { name, startedAt: new Date().toISOString(), env: environment(), params, rows: [] };
}

export async function writeResult(result: BenchResult, out?: string): Promise<string> {
	const stamp = result.startedAt.replace(/[:.]/g, "-");
	const path = out ? resolve(out) : join(root, "bench/results", `${result.name}-${stamp}.json`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
	return path;
}

export function format(value: Metric | undefined, digits = 2): string {
	if (value === null || value === undefined) return "-";
	if (typeof value === "string") return value;
	if (Number.isNaN(value)) return "-";
	return Number.isInteger(value) && Math.abs(value) >= 1000 ? String(value) : value.toFixed(digits);
}

export const pct = (value: number | undefined): string =>
	value === undefined || Number.isNaN(value) ? "-" : `${(value * 100).toFixed(0)}%`;

/** Left-aligned first column, right-aligned numbers. */
export function printTable(headers: readonly string[], lines: readonly (readonly string[])[]): void {
	const widths = headers.map((header, i) => Math.max(header.length, ...lines.map((line) => (line[i] ?? "").length)));
	const render = (cells: readonly string[]) =>
		cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  ");
	console.log(render(headers));
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const line of lines) console.log(render(line));
}
