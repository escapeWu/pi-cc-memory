export function mean(values: readonly number[]): number {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
}

export function percentile(values: readonly number[], p: number): number {
	if (!values.length) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (rank - lo);
}

/** Half-width of a normal-approximation 95% interval for the mean. */
export function ci95(values: readonly number[]): number {
	if (values.length < 2) return Number.NaN;
	const m = mean(values);
	const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
	return 1.96 * Math.sqrt(variance / values.length);
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
	const start = performance.now();
	const value = await fn();
	return { value, ms: performance.now() - start };
}

/** Run `fn` `warmup + iterations` times; return the measured durations in ms. */
export async function sample(fn: () => Promise<unknown>, iterations: number, warmup = 1): Promise<number[]> {
	for (let i = 0; i < warmup; i++) await fn();
	const out: number[] = [];
	for (let i = 0; i < iterations; i++) out.push((await timed(fn)).ms);
	return out;
}

/** Bounded-concurrency map that preserves input order. */
export async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T, index);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
	return results;
}
