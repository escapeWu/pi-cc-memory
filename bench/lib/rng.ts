/** Seeded PRNG so every corpus is reproducible from `--seed`. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function int(rng: Rng, maxExclusive: number): number {
	return Math.floor(rng() * maxExclusive);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
	return items[int(rng, items.length)] as T;
}

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = int(rng, i + 1);
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}
