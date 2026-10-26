import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	assertSafeTopicPath,
	byteLength,
	formatManifest,
	parseFrontmatter,
	parseIndex,
	parseMemoryFile,
	renderIndex,
	serializeMemoryFile,
	topicPathFromTitle,
	truncateIndex,
} from "../src/core/format.ts";

describe("frontmatter", () => {
	test("round-trips a topic file", () => {
		const content = serializeMemoryFile({
			title: "集成测试约定",
			type: "feedback",
			description: "数据库行为及迁移验证的适用条件",
			body: "集成测试需要真实数据库。\n\n**Why:** mock 通过但迁移失败过。",
		});
		const { file, warnings } = parseMemoryFile("feedback_testing.md", content, 1);
		assert.deepEqual(warnings, []);
		assert.equal(file.frontmatter.type, "feedback");
		assert.equal(file.frontmatter.description, "数据库行为及迁移验证的适用条件");
		assert.match(file.body, /集成测试需要真实数据库。/);
	});

	test("keeps unknown type but reports it", () => {
		const raw = "---\nname: x\ndescription: y\ntype: invented\n---\n\nbody\n";
		const { file, warnings } = parseMemoryFile("x.md", raw, 1);
		assert.equal(file.frontmatter.type, "project");
		assert.match(warnings.join("\n"), /unknown frontmatter type/);
	});

	test("treats missing frontmatter as body only", () => {
		const parsed = parseFrontmatter("plain text");
		assert.deepEqual(parsed.data, {});
		assert.equal(parsed.body, "plain text");
	});
});

describe("index", () => {
	test("parses and renders one-line entries", () => {
		const entries = parseIndex("- [A](a.md) — hook a\n- [B](b.md)\n- [A again](a.md) — duplicate\n");
		assert.equal(entries.length, 2);
		assert.deepEqual(entries[0], { title: "A", path: "a.md", hook: "hook a" });

		const rendered = renderIndex(entries);
		assert.match(rendered, /- \[A\]\(a\.md\) — hook a/);
		assert.match(rendered, /# Memory/);
	});

	test("enforces a real UTF-8 byte budget for CJK", () => {
		const line = "- [中文标题](中文主题.md) — 每条索引都写得很长很长";
		const raw = Array.from({ length: 20 }, () => line).join("\n");
		const result = truncateIndex(raw, { maxLines: 200, maxBytes: 300 });

		assert.equal(result.truncated, true);
		const [body] = result.content.split("\n\n> WARNING:");
		assert.ok(byteLength(body ?? "") <= 300);
	});

	test("line cap truncates and warns", () => {
		const raw = Array.from({ length: 5 }, (_, index) => `- [T${index}](t${index}.md)`).join("\n");
		const result = truncateIndex(raw, { maxLines: 2, maxBytes: 10_000 });
		assert.equal(result.truncated, true);
		assert.equal(result.content.split("\n").filter((line) => line.startsWith("- ")).length, 2);
	});
});

describe("paths", () => {
	test("rejects traversal, absolute paths and the index", () => {
		assert.throws(() => assertSafeTopicPath("../escape.md"));
		assert.throws(() => assertSafeTopicPath("/etc/passwd.md"));
		assert.throws(() => assertSafeTopicPath("nested/../../x.md"));
		assert.throws(() => assertSafeTopicPath("notes.txt"));
		assert.throws(() => assertSafeTopicPath("MEMORY.md"));
		assert.throws(() => assertSafeTopicPath(".hidden/x.md"));
	});

	test("accepts nested topic paths", () => {
		assert.equal(assertSafeTopicPath("infra/deploy.md"), "infra/deploy.md");
	});

	test("derives a stable slug from a title", () => {
		assert.equal(topicPathFromTitle("Release Freeze!"), "release-freeze.md");
		assert.equal(topicPathFromTitle("部署约定"), "部署约定.md");
	});
});

describe("manifest", () => {
	test("includes type, path and description", () => {
		const manifest = formatManifest([{ path: "a.md", type: "feedback", description: "hook", mtimeMs: Date.parse("2026-01-01T00:00:00Z") }]);
		assert.equal(manifest, "- [feedback] a.md (2026-01-01T00:00:00.000Z): hook");
	});
});
