/**
 * Deterministic synthetic corpus: topics plus labelled recall queries.
 *
 * Pure (no filesystem, no model). Ground truth is by construction: a query's
 * gold set is the topic(s) generated from the same (domain, facet, subject)
 * triple. Query phrasing deliberately differs from the topic description.
 */
import type { MemoryScope } from "../../src/core/scopes.ts";
import type { MemoryType } from "../../src/core/types.ts";
import { int, mulberry32, pick, type Rng, shuffle } from "./rng.ts";
import { DOMAINS, FACETS, FILLER, OFF_TOPIC, SUBJECTS } from "./vocab.ts";

export type Lang = "en" | "zh";
export type QueryKind = "positive" | "multi" | "near-miss" | "off-topic";

export interface TopicSpec {
	/** `scope:path`, identical to the key recall() uses. */
	key: string;
	scope: MemoryScope;
	path: string;
	type: MemoryType;
	title: string;
	description: string;
	body: string;
	token: string;
	lang: Lang;
	domain: number;
	facet: number;
	subject: number;
	region: number;
	domainVariant: number;
	facetVariant: number;
	ageDays: number;
}

export interface QuerySpec {
	id: string;
	kind: QueryKind;
	text: string;
	lang: Lang;
	/** Topic keys that should be recalled; empty for negatives. */
	gold: string[];
	/** Query language equals every gold topic's description language. */
	sameLang: boolean | null;
	/** Stored topics sharing exactly two of (domain, facet, subject) with the target. */
	neighbors: number;
	hard: boolean;
}

export interface CorpusOptions {
	seed: number;
	size: number;
	positives: number;
	multi: number;
	nearMiss: number;
	offTopic: number;
	/** Probability that a positive seeds explicit same-domain neighbours. */
	hardFraction: number;
	/** Probability that a topic description / query is Chinese. */
	zhFraction: number;
	maxAgeDays: number;
	/** When false every topic goes to the project store. */
	globalEnabled: boolean;
}

export interface Corpus {
	options: CorpusOptions;
	topics: TopicSpec[];
	queries: QuerySpec[];
}

export const DEFAULT_CORPUS: Omit<CorpusOptions, "size"> = {
	seed: 1,
	positives: 24,
	multi: 6,
	nearMiss: 8,
	offTopic: 8,
	hardFraction: 0.5,
	zhFraction: 0.5,
	maxAgeDays: 180,
	globalEnabled: true,
};

interface Triple {
	d: number;
	f: number;
	s: number;
	r: number;
}

const tripleId = (t: Triple) => `${t.d}.${t.f}.${t.s}.${t.r}`;
const DISTINCT = DOMAINS.length * FACETS.length * SUBJECTS.length;
/** Share of the store reserved for query targets and their neighbours. */
const QUERY_CAPACITY = 0.85;

const EN_QUERY: ((f: string, d: string, s: string) => string)[] = [
	(f, d, s) => `What is the ${f} for the ${s} service ${d}?`,
	(f, d, s) => `I need the ${f} of ${s}'s ${d}.`,
	(f, d, s) => `Remind me: ${s} ${d}, ${f}?`,
];
const ZH_QUERY: ((f: string, d: string, s: string) => string)[] = [
	(f, d, s) => `${s} 服务的${d}${f}是什么?`,
	(f, d, s) => `帮我查一下 ${s} 的${d}${f}。`,
];

function phrase(list: readonly string[], variant: number): string {
	return list[variant % list.length] as string;
}

/** A variant index guaranteed to differ from `variant` modulo `length`. */
function otherVariant(rng: Rng, variant: number, length: number): number {
	if (length <= 1) return 0;
	return (variant + 1 + int(rng, length - 1)) % length;
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function neighbours(of: Triple): Triple[] {
	const out: Triple[] = [];
	for (let s = 0; s < SUBJECTS.length; s++) if (s !== of.s) out.push({ ...of, s });
	for (let f = 0; f < FACETS.length; f++) if (f !== of.f) out.push({ ...of, f });
	return out;
}

function enumerate(): Triple[] {
	const out: Triple[] = [];
	for (let d = 0; d < DOMAINS.length; d++)
		for (let f = 0; f < FACETS.length; f++) for (let s = 0; s < SUBJECTS.length; s++) out.push({ d, f, s, r: 0 });
	return out;
}

export function generateCorpus(input: Partial<CorpusOptions> & { size: number }): Corpus {
	const options: CorpusOptions = { ...DEFAULT_CORPUS, ...input };
	const rng = mulberry32(options.seed);
	const queryCount = options.positives + options.multi + options.nearMiss + options.offTopic;
	if (queryCount > 0 && options.size > DISTINCT) {
		throw new Error(`size ${options.size} exceeds the ${DISTINCT} distinct topics that labelled queries can address`);
	}
	if (options.size <= 0) throw new Error("size must be positive");

	const pool = shuffle(rng, enumerate());
	const chosen = new Map<string, Triple>();
	const forbidden = new Set<string>();
	const budget = Math.floor(options.size * QUERY_CAPACITY);
	const reserve = (triples: readonly Triple[]): boolean => {
		const fresh = triples.filter((t) => !chosen.has(tripleId(t)));
		if (chosen.size + fresh.length > budget) return false;
		for (const t of fresh) chosen.set(tripleId(t), t);
		return true;
	};
	const allowed = (t: Triple) => !forbidden.has(tripleId(t));
	const neighbourPair = (t: Triple): Triple[] | undefined => {
		const sameFacet = shuffle(
			rng,
			neighbours(t).filter((n) => n.f === t.f && allowed(n)),
		)[0];
		const sameSubject = shuffle(
			rng,
			neighbours(t).filter((n) => n.s === t.s && allowed(n)),
		)[0];
		return sameFacet && sameSubject ? [sameFacet, sameSubject] : undefined;
	};

	type Plan = { kind: QueryKind; gold: Triple[]; target: Triple[]; offIndex?: number };
	const plans: Plan[] = [];
	const usedGold = new Set<string>();
	const nextFree = (): Triple | undefined => pool.find((t) => allowed(t) && !usedGold.has(tripleId(t)));

	const schedule = shuffle<QueryKind>(rng, [
		...Array<QueryKind>(options.positives).fill("positive"),
		...Array<QueryKind>(options.multi).fill("multi"),
		...Array<QueryKind>(options.nearMiss).fill("near-miss"),
		...Array<QueryKind>(options.offTopic).fill("off-topic"),
	]);
	let offIndex = 0;
	for (const kind of schedule) {
		if (kind === "off-topic") {
			plans.push({ kind, gold: [], target: [], offIndex: offIndex++ });
			continue;
		}
		if (kind === "positive") {
			const t = nextFree();
			if (!t) continue;
			const extra = rng() < options.hardFraction ? neighbourPair(t) : undefined;
			if (!reserve([t, ...(extra ?? [])])) continue;
			usedGold.add(tripleId(t));
			plans.push({ kind, gold: [t], target: [t] });
		} else if (kind === "multi") {
			const a = nextFree();
			if (!a) continue;
			const f2 = shuffle(
				rng,
				FACETS.map((_, f) => f).filter((f) => f !== a.f),
			).find((f) => allowed({ ...a, f }) && !usedGold.has(tripleId({ ...a, f })));
			if (f2 === undefined) continue;
			const b = { ...a, f: f2 };
			if (!reserve([a, b])) continue;
			usedGold.add(tripleId(a));
			usedGold.add(tripleId(b));
			plans.push({ kind, gold: [a, b], target: [a, b] });
		} else {
			const t = pool.find((p) => allowed(p) && !chosen.has(tripleId(p)) && !usedGold.has(tripleId(p)));
			if (!t) continue;
			const pair = neighbourPair(t);
			if (!pair || !reserve(pair)) continue;
			forbidden.add(tripleId(t));
			plans.push({ kind, gold: [], target: [t] });
		}
	}

	// Random distractors up to the requested size.
	for (const t of pool) {
		if (chosen.size >= options.size) break;
		if (allowed(t) && !chosen.has(tripleId(t))) chosen.set(tripleId(t), t);
	}
	// Past the distinct space (L1 scale runs only) replicate triples as regions.
	for (let region = 1; chosen.size < options.size; region++) {
		for (const t of pool) {
			if (chosen.size >= options.size) break;
			const copy = { ...t, r: region };
			if (allowed(t)) chosen.set(tripleId(copy), copy);
		}
	}

	// Topics: shuffled so ages (and thus candidate-window membership) are random.
	const triples = shuffle(rng, [...chosen.values()]);
	const step = options.maxAgeDays / (triples.length + 1);
	const topics = triples.map((t, i) => buildTopic(rng, t, options, (i + 1) * step));
	const byTriple = new Map(topics.map((topic) => [tripleId(topicTriple(topic)), topic]));

	const pairCount = new Map<string, number>();
	const bump = (key: string) => pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
	const pairKeys = (t: Triple) => [`df${t.d}.${t.f}`, `ds${t.d}.${t.s}`, `fs${t.f}.${t.s}`];
	for (const topic of topics) for (const key of pairKeys(topicTriple(topic))) bump(key);
	const neighbourCount = (t: Triple, present: boolean) =>
		pairKeys(t).reduce((sum, key) => sum + (pairCount.get(key) ?? 0) - (present ? 1 : 0), 0);

	const queries: QuerySpec[] = plans.map((plan, index) => {
		const id = `q${String(index + 1).padStart(3, "0")}`;
		const lang: Lang = rng() < options.zhFraction ? "zh" : "en";
		if (plan.kind === "off-topic") {
			const list = OFF_TOPIC[lang];
			return {
				id,
				kind: plan.kind,
				text: list[(plan.offIndex ?? 0) % list.length] as string,
				lang,
				gold: [],
				sameLang: null,
				neighbors: 0,
				hard: false,
			};
		}
		const targets = plan.target.map((t) => byTriple.get(tripleId(t)));
		const present = plan.kind !== "near-miss";
		const neighbors = Math.max(...plan.target.map((t) => neighbourCount(t, present)));
		const golds = present ? targets.filter((t): t is TopicSpec => t !== undefined) : [];
		const first = plan.target[0] as Triple;
		const refTopic = targets[0];
		const dv = refTopic ? refTopic.domainVariant : int(rng, 6);
		const fv = refTopic ? refTopic.facetVariant : int(rng, 6);
		const refLang = refTopic?.lang ?? lang;
		const dp = (l: Lang) => {
			const list = DOMAINS[first.d]?.[l] ?? [];
			return phrase(list, l === refLang ? otherVariant(rng, dv, list.length) : dv);
		};
		const fp = (facet: number, l: Lang, v: number) => {
			const list = FACETS[facet]?.[l] ?? [];
			return phrase(list, l === refLang ? otherVariant(rng, v, list.length) : v);
		};
		const subject = SUBJECTS[first.s] as string;
		let text: string;
		if (plan.kind === "multi") {
			const second = plan.target[1] as Triple;
			const [fa, fb] = [fp(first.f, lang, fv), fp(second.f, lang, fv)];
			text =
				lang === "en"
					? `For the ${subject} service ${dp(lang)}, what are the ${fa} and the ${fb}?`
					: `${subject} 服务的${dp(lang)}:${fa}和${fb}分别是什么?`;
		} else {
			const templates = lang === "en" ? EN_QUERY : ZH_QUERY;
			text = pick(rng, templates)(fp(first.f, lang, fv), dp(lang), subject);
		}
		const sameLang = present ? golds.every((g) => g.lang === lang) : null;
		return { id, kind: plan.kind, text, lang, gold: golds.map((g) => g.key), sameLang, neighbors, hard: neighbors >= 2 };
	});

	return { options, topics, queries };
}

function topicTriple(topic: TopicSpec): Triple {
	return { d: topic.domain, f: topic.facet, s: topic.subject, r: topic.region };
}

function buildTopic(rng: Rng, t: Triple, options: CorpusOptions, ageDays: number): TopicSpec {
	const domain = DOMAINS[t.d];
	const facet = FACETS[t.f];
	const subject = SUBJECTS[t.s];
	if (!domain || !facet || !subject) throw new Error("triple outside vocabulary");
	const lang: Lang = rng() < options.zhFraction ? "zh" : "en";
	const domainVariant = int(rng, 6);
	const facetVariant = int(rng, 6);
	const regionNote = t.r > 0 ? (lang === "en" ? ` (region ${t.r})` : `(区域 ${t.r})`) : "";
	const description =
		lang === "en"
			? `${capitalize(phrase(facet.en, facetVariant))} for the ${subject} service (${phrase(domain.en, domainVariant)})${regionNote}`
			: `${subject} 服务的${phrase(domain.zh, domainVariant)}${phrase(facet.zh, facetVariant)}${regionNote}`;
	const scope: MemoryScope = options.globalEnabled && facet.globalLean && rng() < 0.7 ? "global" : "project";
	const path = `${domain.id}-${subject}-${facet.id}${t.r > 0 ? `-r${t.r}` : ""}.md`;
	const token = `tok-${((rng() * 4294967296) >>> 0).toString(16).padStart(8, "0")}`;
	const body = `The ${facet.en[0]} for the ${subject} ${domain.en[0]} is ${token}.\n\n${pick(rng, FILLER)} ${pick(rng, FILLER)}`;
	return {
		key: `${scope}:${path}`,
		scope,
		path,
		type: facet.type,
		title: `${subject} ${domain.en[0]} ${facet.en[0]}${t.r > 0 ? ` r${t.r}` : ""}`,
		description,
		body,
		token,
		lang,
		domain: t.d,
		facet: t.f,
		subject: t.s,
		region: t.r,
		domainVariant,
		facetVariant,
		ageDays,
	};
}
