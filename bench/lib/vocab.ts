/**
 * Synthetic vocabulary. A topic is a (domain, facet, subject) triple; queries
 * paraphrase the same triple with different phrasings, so selection needs
 * semantics rather than exact string overlap, while shared subject/domain words
 * still make near-neighbours (same domain+subject, other facet) genuinely hard.
 */
import type { MemoryType } from "../../src/core/types.ts";

export interface Phrases {
	readonly en: readonly string[];
	readonly zh: readonly string[];
}
export interface Domain extends Phrases {
	readonly id: string;
}
export interface Facet extends Phrases {
	readonly id: string;
	readonly type: MemoryType;
	/** Cross-project flavour: more likely to live in the global store. */
	readonly globalLean: boolean;
}

export const DOMAINS: readonly Domain[] = [
	{ id: "deploy", en: ["deployment", "release rollout"], zh: ["部署", "发布"] },
	{ id: "database", en: ["database", "data store"], zh: ["数据库", "库表"] },
	{ id: "auth", en: ["authentication", "login and token handling"], zh: ["鉴权", "登录认证"] },
	{ id: "ci", en: ["CI pipeline", "build automation"], zh: ["CI 流水线", "持续集成"] },
	{ id: "logging", en: ["logging", "log collection"], zh: ["日志", "日志采集"] },
	{ id: "cache", en: ["cache layer", "caching"], zh: ["缓存", "缓存层"] },
	{ id: "queue", en: ["message queue", "job queue"], zh: ["消息队列", "任务队列"] },
	{ id: "frontend", en: ["web frontend", "UI client"], zh: ["前端", "网页客户端"] },
	{ id: "testing", en: ["test suite", "automated testing"], zh: ["测试", "自动化测试"] },
	{ id: "monitoring", en: ["monitoring", "alerting setup"], zh: ["监控", "告警配置"] },
	{ id: "billing", en: ["billing", "invoicing"], zh: ["计费", "开票"] },
	{ id: "search", en: ["search index", "full-text search"], zh: ["搜索", "全文检索"] },
];

export const FACETS: readonly Facet[] = [
	{
		id: "owner",
		type: "reference",
		globalLean: false,
		en: ["owner and escalation contact", "who is responsible and whom to page", "on-call owner"],
		zh: ["负责人与升级联系人", "值班负责人"],
	},
	{
		id: "limit",
		type: "project",
		globalLean: false,
		en: ["rate limit and quota", "throttling threshold", "maximum allowed request volume"],
		zh: ["限流与配额", "访问频率上限"],
	},
	{
		id: "rollback",
		type: "project",
		globalLean: false,
		en: ["rollback procedure", "how to revert a bad change", "steps to undo a failed change"],
		zh: ["回滚流程", "故障回退步骤"],
	},
	{
		id: "naming",
		type: "feedback",
		globalLean: true,
		en: ["naming convention", "how things are named", "identifier format rules"],
		zh: ["命名规范", "命名规则"],
	},
	{
		id: "schedule",
		type: "project",
		globalLean: false,
		en: ["maintenance window", "when scheduled work runs", "recurring schedule"],
		zh: ["维护窗口", "定时计划"],
	},
	{
		id: "endpoint",
		type: "reference",
		globalLean: false,
		en: ["endpoint and port", "service address", "host and port to connect to"],
		zh: ["访问端点与端口", "服务地址"],
	},
	{
		id: "retention",
		type: "project",
		globalLean: false,
		en: ["retention policy", "how long data is kept", "data expiry rule"],
		zh: ["保留策略", "数据保留期限"],
	},
	{
		id: "approval",
		type: "project",
		globalLean: false,
		en: ["approval rule", "who must sign off", "review requirement before changes"],
		zh: ["审批规则", "变更评审要求"],
	},
	{
		id: "incident",
		type: "project",
		globalLean: false,
		en: ["incident postmortem", "notes from the last outage", "outage lessons learned"],
		zh: ["故障复盘", "上次事故总结"],
	},
	{
		id: "preference",
		type: "feedback",
		globalLean: true,
		en: ["team preference", "preferred way of working", "agreed working style"],
		zh: ["团队偏好", "约定的工作方式"],
	},
];

export const SUBJECTS: readonly string[] = [
	"orders",
	"inventory",
	"ledger",
	"notifier",
	"gateway",
	"scheduler",
	"uploader",
	"reports",
	"catalog",
	"checkout",
	"identity",
	"exporter",
];

export const OFF_TOPIC = {
	en: [
		"Rename this variable to camelCase and keep the tests passing.",
		"Write a haiku about autumn rain.",
		"Explain what this regular expression does: ^\\d{3}-\\d{4}$",
		"Fix the typo in the third paragraph of the README.",
		"How do I squash the last three commits with git rebase?",
		"Convert this JSON snippet to YAML.",
		"What is the time complexity of binary search?",
		"Summarize the difference between a mutex and a semaphore.",
	],
	zh: [
		"帮我把这个函数改成异步的。",
		"写一首关于秋天的短诗。",
		"解释一下这个正则表达式是做什么的:^[a-z]+$",
		"把 README 里第三段的错别字改掉。",
		"git rebase 怎么合并最近三个提交?",
		"把这段 JSON 转成 YAML。",
		"二分查找的时间复杂度是多少?",
		"简单说说互斥锁和信号量的区别。",
	],
} as const;

export const FILLER: readonly string[] = [
	"This note was recorded during a planning discussion and reviewed afterwards.",
	"The details were confirmed with the responsible team and may be revisited later.",
	"Check the linked runbook before acting on this; the value was valid when saved.",
	"No credentials are stored here; this is synthetic benchmark data only.",
	"The decision applies to the current environment and was not tested elsewhere.",
	"Keep this entry short; add a new topic instead of extending it.",
];
