/**
 * Deleting sources or pages rebuilds the index from the pages that are
 * left, instead of editing `index.md` line by line.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)
vi.mock("@/lib/embedding", () => ({ removePageEmbedding: vi.fn(async () => {}) }))

import { cleanupDeletedWikiPages, deleteSourceFiles } from "./source-lifecycle"
import { useWikiStore } from "@/stores/wiki-store"

let tmp: { path: string; cleanup: () => Promise<void> }

function page(title: string, sources: string[]): string {
  return `---\ntitle: ${title}\nsources: [${sources.join(", ")}]\nupdated: 2026-10-21\n---\n\n# ${title}\n\n${title} body.\n`
}

beforeEach(async () => {
  tmp = await createTempProject("lifecycle-index")
  useWikiStore.setState({ outputLanguage: "English" })
  const w = `${tmp.path}/wiki`
  await writeFileRaw(`${w}/concepts/keep.md`, page("Keep", ["other.md"]))
  await writeFileRaw(`${w}/concepts/drop.md`, page("Drop", ["gone.md"]))
  // a hand-made old index with a line the line-editor would never remove
  await writeFileRaw(`${w}/index.md`, "# Index\n\n- [[keep]]\n- [[drop]]\n- Drop page (see drop)\n")
  await writeFileRaw(`${w}/index/old.md`, "- [[drop]]\n")
  await writeFileRaw(`${tmp.path}/raw/sources/gone.md`, "gone\n")
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("deleting rebuilds the index", () => {
  it("deleteSourceFiles rebuilds the index instead of editing index.md lines", async () => {
    await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/gone.md`])
    expect(await fileExists(`${tmp.path}/wiki/concepts/drop.md`)).toBe(false)
    const top = await readFileRaw(`${tmp.path}/wiki/index.md`)
    expect(top).toContain("[[keep]]")
    expect(top).not.toMatch(/drop/i)
    expect(await fileExists(`${tmp.path}/wiki/index/old.md`)).toBe(false)
    expect(await readFileRaw(`${tmp.path}/wiki/index/concepts.md`)).not.toContain("[[drop]]")
  })

  it("cleanupDeletedWikiPages rebuilds the index instead of editing index.md lines", async () => {
    // the page was removed outside the app; the watcher reports it
    await realFs.deleteFile(`${tmp.path}/wiki/concepts/drop.md`)
    await cleanupDeletedWikiPages(tmp.path, ["wiki/concepts/drop.md"])
    const top = await readFileRaw(`${tmp.path}/wiki/index.md`)
    expect(top).toContain("[[keep]]")
    expect(top).not.toMatch(/drop/i)
    expect(await fileExists(`${tmp.path}/wiki/index/old.md`)).toBe(false)
  })
})

describe("GenOffice's own pages are never another source's pages", () => {
  // GenOffice lists the original document's absolute path; the mirror copy has the same bare name
  const genofficePage = [
    "---",
    "type: work",
    "title: 보고서 업무",
    // as GenOffice's serializePage writes it (JSON-quoted, backslashes doubled)
    `sources: [${JSON.stringify("C:\\Users\\u\\Documents\\보고서.docx")}]`,
    "updated: 2026-10-21",
    "---",
    "## 개요",
    "누적된 업무 기록",
    "",
  ].join("\n")

  beforeEach(async () => {
    await writeFileRaw(`${tmp.path}/wiki/work/보고서-업무.md`, genofficePage)
    await writeFileRaw(`${tmp.path}/wiki/sources/보고서.md`, page("보고서 요약", ["보고서.docx"]))
    await writeFileRaw(`${tmp.path}/raw/sources/genoffice-saved/보고서.docx`, "copy\n")
  })

  it("a changed copy (replace mode) keeps a page whose source is an absolute path", async () => {
    await deleteSourceFiles(tmp.path, ["raw/sources/genoffice-saved/보고서.docx"], {
      fileAlreadyDeleted: true,
      keepMultiSourcePages: true,
      keepLinksToDeleted: true,
    })
    expect(await fileExists(`${tmp.path}/wiki/sources/보고서.md`)).toBe(false)
    expect(await readFileRaw(`${tmp.path}/wiki/work/보고서-업무.md`)).toBe(genofficePage)
  })

  it("deleting the copy keeps it too, unchanged", async () => {
    await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/genoffice-saved/보고서.docx`])
    expect(await readFileRaw(`${tmp.path}/wiki/work/보고서-업무.md`)).toBe(genofficePage)
  })
})
