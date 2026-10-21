/**
 * Index files (`wiki/index.md`, `wiki/index/**`) are not pages: lint and
 * the graph must not treat `wiki/index/concepts.md` as a page "concepts".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { runStructuralLint } from "./lint"
import { buildWikiGraph } from "./wiki-graph"
import { isIndexNode } from "./wiki-index"

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("index-walkers")
  const w = `${tmp.path}/wiki`
  await writeFileRaw(`${w}/concepts/alpha.md`, "---\ntitle: Alpha\n---\n# Alpha\n\nSee [[beta]].\n")
  await writeFileRaw(`${w}/concepts/beta.md`, "---\ntitle: Beta\n---\n# Beta\n\nSee [[alpha]].\n")
  await writeFileRaw(`${w}/index.md`, "# 위키 목차\n\n- [[alpha]] — Alpha\n")
  await writeFileRaw(`${w}/index/concepts.md`, "# 개념 (2)\n\n- [[alpha]] — Alpha\n- [[beta]] — Beta\n")
  await writeFileRaw(`${w}/index/work/2026.md`, "# 작업물 › 2026 (1)\n\n- [[missing-page]] — gone\n")
})
afterEach(async () => {
  await tmp.cleanup()
})

describe("walkers skip index files", () => {
  it("lint reports no orphan or broken link from wiki/index/**", async () => {
    const results = await runStructuralLint(tmp.path)
    const pages = results.map((r) => r.page)
    expect(pages.some((p) => /(^|\/)index\//.test(p) || p === "concepts.md" || p.includes("2026"))).toBe(false)
  })

  it("graph has no node for an index file", async () => {
    const graph = await buildWikiGraph(tmp.path)
    const ids = graph.nodes.map((n) => n.id)
    expect(ids).toEqual(expect.arrayContaining(["alpha", "beta"]))
    expect(ids).not.toContain("concepts")
    expect(ids).not.toContain("2026")
    expect(ids).not.toContain("index")
  })

  it("isIndexNode matches the index folder and top index only, by node", () => {
    expect(isIndexNode({ path: "C:/p/wiki/index", is_dir: true })).toBe(true)
    expect(isIndexNode({ path: "C:\\p\\wiki\\index.md", is_dir: false })).toBe(true)
    expect(isIndexNode({ path: "C:/p/wiki/concepts/index.md", is_dir: false })).toBe(false)
    expect(isIndexNode({ path: "C:/p/wiki/concepts", is_dir: true })).toBe(false)
    // a project that itself lives under a folder called wiki/index
    expect(isIndexNode({ path: "C:/wiki/index/proj/wiki/concepts", is_dir: true })).toBe(false)
  })
})
