/**
 * What part of the index goes into a prompt: the top index plus the page
 * lines that share words with the question or source, within a budget.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { capOverview, selectIndexContext, trimIndexByRelevance } from "./index-context"
import { buildIndexFiles, CATEGORY_LABELS, type IndexPage } from "./wiki-index"
import { buildAnalysisPrompt, buildGenerationPrompt } from "./ingest"

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("index-context")
})
afterEach(async () => {
  await tmp.cleanup()
})

async function writeIndexFor(pages: IndexPage[]): Promise<void> {
  for (const [rel, text] of buildIndexFiles(pages, "Korean")) {
    await writeFileRaw(`${tmp.path}/${rel}`, text)
  }
}

describe("selectIndexContext", () => {
  it("selectIndexContext stays within budget on a 1,200-page wiki and keeps a line whose title shares a token with the query", async () => {
    const cats = Object.keys(CATEGORY_LABELS)
    const pages: IndexPage[] = []
    for (let i = 0; i < 1200; i++) {
      pages.push({
        relPath: `wiki/${cats[i % cats.length]}/page-${i}.md`,
        category: cats[i % cats.length],
        slug: `page-${i}`,
        title: `일반 페이지 ${i}`,
        summary: "특별한 내용이 없는 요약입니다.",
        tags: [`주제${i % 40}`],
        updated: `2025-0${1 + (i % 9)}-01`,
      })
    }
    pages.push({
      relPath: "wiki/concepts/edtech-platform.md",
      category: "concepts",
      slug: "edtech-platform",
      title: "에듀테크 플랫폼 구축",
      summary: "학습관리시스템을 만든 사례",
      tags: ["주제1"],
      updated: "2020-01-01",
    })
    await writeIndexFor(pages)

    const budget = 6400
    const ctx = await selectIndexContext(tmp.path, "에듀테크는 어떤 사업이었지?", budget)
    expect(ctx.length).toBeLessThanOrEqual(budget)
    expect(ctx).toContain("[[edtech-platform]]")
    // the top index comes first
    expect(ctx.startsWith("# 위키 목차")).toBe(true)
  })

  it("falls back to trimming the top index when there are no index files", async () => {
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n\n## Concepts\n- [[a]] alpha\n")
    expect(await selectIndexContext(tmp.path, "alpha", 6000)).toBe("# Index\n\n## Concepts\n- [[a]] alpha\n")
  })

  it("is empty when the wiki has no index", async () => {
    expect(await selectIndexContext(tmp.path, "anything", 6000)).toBe("")
  })

  it("never exceeds a budget smaller than the top index", async () => {
    const pages: IndexPage[] = Array.from({ length: 50 }, (_, i) => ({
      relPath: `wiki/concepts/c${i}.md`,
      category: "concepts",
      slug: `c${i}`,
      title: `개념 ${i}`,
      summary: "",
      tags: [],
      updated: "2026-01-01",
    }))
    await writeIndexFor(pages)
    expect((await selectIndexContext(tmp.path, "개념", 300)).length).toBeLessThanOrEqual(300 + 50)
  })
})

describe("trimIndexByRelevance", () => {
  it("returns the index unchanged when it fits", () => {
    expect(trimIndexByRelevance("# I\n## A\n- [[x]]", "x", 1000)).toBe("# I\n## A\n- [[x]]")
  })

  it("keeps ## lines and lines with query tokens, and marks the cut", () => {
    const raw = ["# Index", "## Concepts", "- [[attention]] — attention", "- [[rope]] — rotary", "## Entities", "- [[bob]] — designer"].join("\n")
    const out = trimIndexByRelevance(raw, "rotary embedding", 60)
    expect(out).toContain("## Concepts")
    expect(out).toContain("## Entities")
    expect(out).toContain("[[rope]]")
    expect(out).not.toContain("[[bob]]")
    expect(out.endsWith("[...index trimmed to relevant entries...]")).toBe(true)
  })
})

describe("prompts", () => {
  it("the generation prompt no longer asks for an updated wiki/index.md and labels the index as relevant entries", () => {
    const prompt = buildGenerationPrompt("schema", "purpose", "- [[x]]", "source.pdf")
    expect(prompt).not.toMatch(/updated wiki\/index\.md/i)
    expect(prompt).toContain("## Relevant Wiki Index (for linking; the app maintains the index)")
    const analysis = buildAnalysisPrompt("purpose", "- [[x]]", "content")
    expect(analysis).toContain("## Relevant Wiki Index")
  })

  it("overview in prompts is capped at 6000 chars", () => {
    const overview = "가".repeat(10_000)
    const prompt = buildGenerationPrompt("schema", "purpose", "", "source.pdf", overview)
    const run = /가+/.exec(prompt)![0]
    expect(run.length).toBeLessThanOrEqual(6000)
    expect(capOverview(overview).length).toBeLessThanOrEqual(6000)
    expect(capOverview("short")).toBe("short")
  })
})
