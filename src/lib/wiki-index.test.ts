/**
 * The two-level wiki index is built from the pages on disk, never by the
 * LLM. These tests pin its shape and its size limits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("./output-language", () => ({ currentOutputLanguage: () => "Korean" }))

import {
  buildIndexFiles,
  collectIndexPages,
  rebuildWikiIndex,
  refreshWikiIndex,
  isIndexFilePath,
  CATEGORY_LABELS,
  type IndexPage,
} from "./wiki-index"

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("wiki-index")
})
afterEach(async () => {
  await tmp.cleanup()
})

function page(
  category: string,
  slug: string,
  opts: { tags?: string[]; updated?: string; title?: string; summary?: string } = {},
): IndexPage {
  return {
    relPath: `wiki/${category}/${slug}.md`,
    category,
    slug,
    title: opts.title ?? slug,
    summary: opts.summary ?? "",
    tags: opts.tags ?? [],
    updated: opts.updated ?? "2026-01-01",
  }
}

function md(fm: Record<string, string>, body: string): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join("\n")}\n---\n${body}`
}

function linesOf(text: string): number {
  return text.split("\n").length
}

describe("collectIndexPages", () => {
  it("lists every page of every category and nothing else", async () => {
    const w = `${tmp.path}/wiki`
    await writeFileRaw(
      `${w}/concepts/edtech.md`,
      md(
        { type: "concept", title: '"에듀테크"', tags: "[개념, 교육]", updated: "2026-04-29" },
        "# 에듀테크\n\n## 정의\n\n교육과 기술을 합친 말이다.\n",
      ),
    )
    await writeFileRaw(
      `${w}/work/oda.md`,
      md({ type: "work", title: "ODA 제안서", summary: "제안서 참조 업무", updated: "2026-10-21" }, "## 개요\n\n본문\n"),
    )
    await writeFileRaw(`${w}/sources/plain.md`, "그냥 본문 한 줄\n")
    await writeFileRaw(`${w}/index.md`, "# old\n")
    await writeFileRaw(`${w}/overview.md`, "# overview\n")
    await writeFileRaw(`${w}/index/concepts.md`, "- [[edtech]]\n")
    await writeFileRaw(`${w}/media/x/pic.md`, "not a page\n")
    await writeFileRaw(`${w}/sources/notes.txt`, "not markdown\n")

    const pages = await collectIndexPages(tmp.path)
    const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]))
    expect(Object.keys(bySlug).sort()).toEqual(["edtech", "oda", "plain"])
    expect(bySlug.edtech).toMatchObject({
      relPath: "wiki/concepts/edtech.md",
      category: "concepts",
      title: "에듀테크",
      summary: "교육과 기술을 합친 말이다.",
      tags: ["개념", "교육"],
      updated: "2026-04-29",
    })
    expect(bySlug.oda).toMatchObject({ category: "work", title: "ODA 제안서", summary: "제안서 참조 업무" })
    expect(bySlug.plain).toMatchObject({ category: "sources", title: "plain", summary: "그냥 본문 한 줄" })
  })

  it("cuts a summary to 120 characters", async () => {
    await writeFileRaw(`${tmp.path}/wiki/concepts/long.md`, `# 제목\n\n${"가".repeat(300)}\n`)
    const [p] = await collectIndexPages(tmp.path)
    expect(p.summary.length).toBeLessThanOrEqual(120)
  })
})

describe("buildIndexFiles", () => {
  it("top index is under 4000 chars with page counts and 5 recent pages per category", () => {
    const pages: IndexPage[] = []
    for (let i = 0; i < 12; i++) pages.push(page("concepts", `c${i}`, { updated: `2026-01-${String(i + 1).padStart(2, "0")}` }))
    for (let i = 0; i < 3; i++) pages.push(page("sources", `s${i}`))
    const files = buildIndexFiles(pages, "ko")
    const top = files.get("wiki/index.md")!
    expect(top.length).toBeLessThanOrEqual(4000)
    expect(top).toContain(CATEGORY_LABELS.concepts.ko)
    expect(top).toContain("12")
    // the five most recently updated concepts, newest first, and no older ones
    // categories follow CATEGORY_LABELS order, so concepts come after sources
    expect(top.indexOf(`## ${CATEGORY_LABELS.sources.ko}`)).toBeLessThan(top.indexOf(`## ${CATEGORY_LABELS.concepts.ko}`))
    const concepts = top.slice(top.indexOf(`## ${CATEGORY_LABELS.concepts.ko}`))
    const listed = [...concepts.matchAll(/\[\[(c\d+)\]\]/g)].map((m) => m[1])
    expect(listed).toEqual(["c11", "c10", "c9", "c8", "c7"])
    expect(top).toContain("index/concepts.md")
    expect(files.has("wiki/index/concepts.md")).toBe(true)
    expect(files.get("wiki/index/concepts.md")).toContain("- [[c0]] — c0")
  })

  it("uses English labels for a non-Korean language", () => {
    const files = buildIndexFiles([page("concepts", "a")], "English")
    expect(files.get("wiki/index.md")).toContain(CATEGORY_LABELS.concepts.en)
  })

  it("a category of 201 pages is split into groups by the first tag that is not the category name", () => {
    const pages: IndexPage[] = []
    for (let i = 0; i < 201; i++) {
      pages.push(page("concepts", `p${i}`, { tags: i < 100 ? ["개념", "교육"] : ["concept", "기술"] }))
    }
    const files = buildIndexFiles(pages, "ko")
    const listing = files.get("wiki/index/concepts.md")!
    expect(listing).toContain("index/concepts/교육.md")
    expect(listing).toContain("index/concepts/기술.md")
    expect(listing).not.toContain("[[p0]]")
    expect(files.get("wiki/index/concepts/교육.md")).toContain("[[p0]]")
    expect(files.get("wiki/index/concepts/기술.md")).toContain("[[p150]]")
    expect(files.has("wiki/index/concepts/개념.md")).toBe(false)
  })

  it("groups under 5 pages and untagged pages go to 기타; at most 30 groups are listed", () => {
    const pages: IndexPage[] = []
    // 35 tags with 6 pages each = 210 pages, 3 tiny tags, 5 untagged
    for (let t = 0; t < 35; t++) {
      for (let i = 0; i < 6; i++) pages.push(page("entities", `e${t}-${i}`, { tags: [`태그${t}`] }))
    }
    for (let t = 0; t < 3; t++) pages.push(page("entities", `tiny${t}`, { tags: [`작은${t}`] }))
    for (let i = 0; i < 5; i++) pages.push(page("entities", `none${i}`))
    const files = buildIndexFiles(pages, "ko")
    const listing = files.get("wiki/index/entities.md")!
    const groups = [...listing.matchAll(/index\/entities\/([^\s)]+)\.md/g)].map((m) => m[1])
    expect(new Set(groups).size).toBe(groups.length)
    expect(groups.length).toBeLessThanOrEqual(30)
    expect(groups).toContain("기타")
    const other = files.get("wiki/index/entities/기타.md")!
    expect(other).toContain("[[tiny0]]")
    expect(other).toContain("[[none0]]")
    // every page lands in exactly one group file
    const all = [...files.entries()]
      .filter(([k]) => k.startsWith("wiki/index/entities/"))
      .flatMap(([, v]) => [...v.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]))
    expect(all.length).toBe(pages.length)
    expect(new Set(all).size).toBe(pages.length)
  })

  it("work pages are grouped by the year of updated; methods and clients go to numbered parts", () => {
    const pages: IndexPage[] = []
    for (let i = 0; i < 150; i++) pages.push(page("work", `w25-${i}`, { updated: "2025-03-01" }))
    for (let i = 0; i < 100; i++) pages.push(page("work", `w26-${i}`, { updated: "2026-03-01" }))
    for (let i = 0; i < 250; i++) pages.push(page("methods", `m${i}`, { tags: ["보고서"] }))
    const files = buildIndexFiles(pages, "ko")
    expect(files.get("wiki/index/work.md")).toContain("index/work/2025.md")
    expect(files.get("wiki/index/work/2026.md")).toContain("[[w26-0]]")
    expect(files.has("wiki/index/methods/보고서.md")).toBe(false)
    expect(files.has("wiki/index/methods-2.md")).toBe(true)
    const methods = (files.get("wiki/index/methods.md") ?? "") + (files.get("wiki/index/methods-2.md") ?? "")
    expect(methods).toContain("[[m0]]")
    expect(methods).toContain("[[m249]]")
    expect(files.get("wiki/index/methods.md")).toContain("index/methods-2.md")
  })

  it("every index file is at most 6000 chars or 200 lines, cut into numbered parts", () => {
    const pages: IndexPage[] = []
    for (let i = 0; i < 190; i++) {
      pages.push(page("sources", `s${i}`, { title: "제목".repeat(30), summary: "요약".repeat(60) }))
    }
    const files = buildIndexFiles(pages, "ko")
    expect(files.has("wiki/index/sources-2.md")).toBe(true)
    for (const [, text] of files) {
      expect(text.length).toBeLessThanOrEqual(6000)
      expect(linesOf(text)).toBeLessThanOrEqual(200)
    }
    const listed = [...files.entries()]
      .filter(([k]) => /^wiki\/index\/sources(-\d+)?\.md$/.test(k))
      .flatMap(([, v]) => [...v.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]))
    expect(new Set(listed).size).toBe(190)
  })

  it("1,200 synthetic pages: top index ≤ 4000, every file ≤ 6000", () => {
    const cats = Object.keys(CATEGORY_LABELS)
    const pages: IndexPage[] = []
    for (let i = 0; i < 1200; i++) {
      const c = cats[i % cats.length]
      pages.push(
        page(c, `page-with-a-rather-long-slug-number-${i}`, {
          title: `꽤 긴 페이지 제목 ${i} `.repeat(4),
          summary: "요약 문장이 들어갑니다. ".repeat(10),
          tags: [`주제${i % 40}`],
          updated: `20${20 + (i % 7)}-0${1 + (i % 9)}-15`,
        }),
      )
    }
    // one category far over the split limit
    for (let i = 0; i < 400; i++) pages.push(page("concepts", `extra-${i}`, { tags: [`주제${i % 50}`] }))
    const files = buildIndexFiles(pages, "ko")
    expect(files.get("wiki/index.md")!.length).toBeLessThanOrEqual(4000)
    for (const [, text] of files) {
      expect(text.length).toBeLessThanOrEqual(6000)
      expect(linesOf(text)).toBeLessThanOrEqual(200)
    }
  })
})

describe("rebuildWikiIndex", () => {
  it("rebuildWikiIndex removes stale files under wiki/index and replaces an old index.md", async () => {
    const w = `${tmp.path}/wiki`
    await writeFileRaw(`${w}/concepts/alive.md`, md({ title: "살아있음" }, "본문\n"))
    const stale = Array.from({ length: 18 }, (_, i) => `- [[gone-${i}]] — 지워진 페이지`).join("\n")
    await writeFileRaw(`${w}/index.md`, `# Index\n\n${stale}\n`)
    await writeFileRaw(`${w}/index/old-category.md`, "- [[gone-0]]\n")
    await writeFileRaw(`${w}/index/concepts/old-group.md`, "- [[gone-1]]\n")

    const result = await rebuildWikiIndex(tmp.path, "ko")

    const top = await readFileRaw(`${w}/index.md`)
    expect(top).not.toContain("gone-")
    expect(top).toContain("[[alive]]")
    expect(await fileExists(`${w}/index/old-category.md`)).toBe(false)
    expect(await fileExists(`${w}/index/concepts/old-group.md`)).toBe(false)
    expect(await readFileRaw(`${w}/index/concepts.md`)).toContain("[[alive]]")
    expect(result.written).toContain("wiki/index.md")
    expect(result.removed.sort()).toEqual(["wiki/index/concepts/old-group.md", "wiki/index/old-category.md"])

    // a second rebuild with nothing changed writes nothing
    const again = await rebuildWikiIndex(tmp.path, "ko")
    expect(again).toEqual({ written: [], removed: [] })
  })
})

describe("refreshWikiIndex", () => {
  it("a rebuild requested during another one runs again, so the later change is listed", async () => {
    const w = `${tmp.path}/wiki`
    await writeFileRaw(`${w}/concepts/first.md`, "# first\n")
    const one = refreshWikiIndex(tmp.path)
    await writeFileRaw(`${w}/concepts/second.md`, "# second\n")
    const two = refreshWikiIndex(tmp.path)
    await Promise.all([one, two])
    const list = await readFileRaw(`${w}/index/concepts.md`)
    expect(list).toContain("[[first]]")
    expect(list).toContain("[[second]]")
  })

  it("never throws when the wiki folder is missing", async () => {
    await expect(refreshWikiIndex(`${tmp.path}/nope`)).resolves.toBeUndefined()
  })
})

describe("isIndexFilePath", () => {
  it("is true for wiki/index.md and wiki/index/** only", () => {
    expect(isIndexFilePath("wiki/index.md")).toBe(true)
    expect(isIndexFilePath("wiki/Index.md")).toBe(true)
    expect(isIndexFilePath("wiki/index/concepts.md")).toBe(true)
    expect(isIndexFilePath("wiki\\index\\concepts\\교육.md")).toBe(true)
    expect(isIndexFilePath("wiki/concepts/index.md")).toBe(false)
    expect(isIndexFilePath("wiki/indexing.md")).toBe(false)
    expect(isIndexFilePath("wiki/overview.md")).toBe(false)
  })
})
