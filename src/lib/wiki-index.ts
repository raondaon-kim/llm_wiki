/**
 * The wiki's table of contents, built from the pages on disk.
 *
 * Two levels keep it small enough for an AI to read first:
 *   - `wiki/index.md` (at most 4,000 chars): each category with its size,
 *     last update and its five most recent pages.
 *   - `wiki/index/<category>.md`: one line per page. A category over 200
 *     pages lists groups instead (by tag, or by year for `work`), each in
 *     `wiki/index/<category>/<group>.md`.
 * Every file is cut into numbered parts (`…-2.md`) at 6,000 chars or 200
 * lines. This module is the only writer of these files; the LLM never
 * rewrites the index.
 */
import { deleteFile, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { parseFrontmatter } from "./frontmatter"
import { normalizePath } from "./path-utils"
import { currentOutputLanguage } from "./output-language"

export interface IndexPage {
  relPath: string
  category: string
  slug: string
  title: string
  summary: string
  tags: string[]
  updated: string
}

export const CATEGORY_LABELS: Record<string, { ko: string; en: string; descKo: string; descEn: string }> = {
  sources: { ko: "자료", en: "Sources", descKo: "위키에 들어온 원본 자료의 요약", descEn: "Summaries of the source documents" },
  entities: { ko: "인물·기관", en: "Entities", descKo: "사람, 기관, 제품 같은 고유한 대상", descEn: "People, organizations and products" },
  concepts: { ko: "개념", en: "Concepts", descKo: "개념, 방법, 용어", descEn: "Ideas, methods and terms" },
  queries: { ko: "질문", en: "Queries", descKo: "저장해 둔 질문과 답", descEn: "Saved questions and answers" },
  comparisons: { ko: "비교", en: "Comparisons", descKo: "둘 이상을 견준 정리", descEn: "Side-by-side comparisons" },
  synthesis: { ko: "종합", en: "Synthesis", descKo: "여러 자료를 묶은 종합 정리", descEn: "Summaries across sources" },
  work: { ko: "작업물", en: "Work", descKo: "앱에서 만들고 저장한 문서의 기록", descEn: "Documents made and saved in the apps" },
  methods: { ko: "작업 방식", en: "Methods", descKo: "되풀이되는 작업 방법과 형식", descEn: "Recurring ways of working" },
  clients: { ko: "발주처", en: "Clients", descKo: "발주처와 고객", descEn: "Clients and customers" },
}

/** Tags that only repeat the category, so they never name a group. */
const CATEGORY_TAG_ALIASES: Record<string, string[]> = {
  sources: ["source", "출처", "원본"],
  entities: ["entity", "인물", "기관", "개체", "엔티티"],
  concepts: ["concept"],
  queries: ["query"],
  comparisons: ["comparison"],
  synthesis: ["synthesis"],
  work: ["작업"],
  methods: ["method", "방식"],
  clients: ["client", "고객"],
}

const TOP_MAX_CHARS = 4000
const FILE_MAX_CHARS = 6000
const FILE_MAX_LINES = 200
const SPLIT_OVER = 200
const MIN_GROUP = 5
const MAX_GROUPS = 30
const RECENT = 5
const SUMMARY_MAX = 120
const TITLE_MAX = 120
const SKIP_FOLDERS = new Set(["index", "media"])
/** Categories over the split limit that are cut into parts, not grouped. */
const PARTS_ONLY = new Set(["methods", "clients"])

function isKorean(lang: string): boolean {
  return lang.trim().toLowerCase().startsWith("ko") || lang.includes("한국")
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function asTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []
  return list
    .map((t) => String(t).replace(/^#/, "").trim())
    .filter((t) => t.length > 0)
}

function firstBodyLine(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith("---") || line.startsWith("```")) continue
    if (line.startsWith("|") || line.startsWith("<!--")) continue
    return line
      .replace(/^([-*+]|>|\d+\.)\s+/, "")
      .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, target: string, _a, alias?: string) => alias ?? target)
      .replace(/\*\*|__|`/g, "")
  }
  return ""
}

function walkFiles(nodes: FileNode[], out: FileNode[]): void {
  for (const n of nodes) {
    if (n.is_dir) walkFiles(n.children ?? [], out)
    else out.push(n)
  }
}

export async function collectIndexPages(projectPath: string): Promise<IndexPage[]> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const wikiDir = `${root}/wiki`
  let top: FileNode[]
  try {
    top = await listDirectory(wikiDir)
  } catch {
    return []
  }
  const pages: IndexPage[] = []
  for (const folder of top) {
    if (!folder.is_dir || SKIP_FOLDERS.has(folder.name)) continue
    const files: FileNode[] = []
    walkFiles(folder.children ?? [], files)
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith(".md")) continue
      const abs = normalizePath(f.path)
      let content: string
      try {
        content = await readFile(abs)
      } catch {
        continue
      }
      const { frontmatter, body } = parseFrontmatter(content)
      const fm = frontmatter ?? {}
      const slug = f.name.replace(/\.md$/i, "")
      pages.push({
        relPath: `wiki/${folder.name}/${abs.slice(`${wikiDir}/${folder.name}/`.length)}`,
        category: folder.name,
        slug,
        title: clip(asString(fm.title) || slug, TITLE_MAX),
        summary: clip(asString(fm.summary) || firstBodyLine(body), SUMMARY_MAX),
        tags: asTags(fm.tags),
        updated: asString(fm.updated) || asString(fm.created),
      })
    }
  }
  return pages.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
}

interface Words {
  topTitle: string
  note: string
  total: (n: number) => string
  updated: string
  list: string
  groups: string
  next: string
  other: string
  part: (i: number, n: number) => string
}

function words(lang: string): Words {
  return isKorean(lang)
    ? {
        topTitle: "# 위키 목차",
        note: "> 페이지 목록에서 자동으로 만든 목차입니다. 고쳐도 다음 갱신 때 다시 만들어집니다.",
        total: (n) => `페이지 ${n}개`,
        updated: "최근 갱신",
        list: "목록",
        groups: "묶음별 목록:",
        next: "다음",
        other: "기타",
        part: (i, n) => ` — ${i}/${n}`,
      }
    : {
        topTitle: "# Wiki index",
        note: "> Built from the pages on disk. Edits are replaced on the next rebuild.",
        total: (n) => `${n} pages`,
        updated: "updated",
        list: "list",
        groups: "Lists by group:",
        next: "Next",
        other: "Other",
        part: (i, n) => ` — ${i}/${n}`,
      }
}

function label(category: string, lang: string): { name: string; desc: string } {
  const l = CATEGORY_LABELS[category]
  if (!l) return { name: category, desc: "" }
  return isKorean(lang) ? { name: l.ko, desc: l.descKo } : { name: l.en, desc: l.descEn }
}

function byRecent(a: IndexPage, b: IndexPage): number {
  if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
}

function pageLine(p: IndexPage): string {
  const head = `- [[${p.slug}]] — ${p.title}`
  return p.summary ? `${head} — ${p.summary}` : head
}

function fileKey(name: string): string {
  let key = name
    .replace(/[\\/:*?"<>|#[\]]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(key)) key = `_${key}`
  return key
}

/**
 * Cut `lines` into files of at most FILE_MAX_CHARS / FILE_MAX_LINES each,
 * named `<base>.md`, `<base>-2.md`, … with a header and a "next" pointer.
 */
function writeParts(
  out: Map<string, string>,
  base: string,
  header: (part: string) => string[],
  lines: string[],
  w: Words,
): void {
  const reserveChars = 400
  const reserveLines = 6
  const chunks: string[][] = []
  let cur: string[] = []
  let size = 0
  for (const line of lines) {
    const add = line.length + 1
    if (cur.length > 0 && (size + add > FILE_MAX_CHARS - reserveChars || cur.length + 1 > FILE_MAX_LINES - reserveLines)) {
      chunks.push(cur)
      cur = []
      size = 0
    }
    cur.push(line)
    size += add
  }
  chunks.push(cur)
  const n = chunks.length
  const rel = (i: number) => `${base}${i === 1 ? "" : `-${i}`}.md`
  chunks.forEach((chunk, idx) => {
    const i = idx + 1
    const text = [...header(n > 1 ? w.part(i, n) : ""), "", ...chunk]
    if (i < n) text.push("", `${w.next}: ${rel(i + 1).replace(/^wiki\//, "")}`)
    out.set(rel(i), `${text.join("\n")}\n`)
  })
}

function groupPages(category: string, pages: IndexPage[], lang: string): Array<{ key: string; label: string; pages: IndexPage[] }> {
  const w = words(lang)
  const otherKey = fileKey(w.other)
  const groups = new Map<string, { key: string; label: string; pages: IndexPage[] }>()
  const put = (name: string, p: IndexPage) => {
    const key = fileKey(name) || otherKey
    const id = key.toLowerCase()
    const g = groups.get(id) ?? { key, label: key === otherKey ? w.other : name, pages: [] }
    g.pages.push(p)
    groups.set(id, g)
  }
  if (category === "work") {
    for (const p of pages) put(/^(\d{4})/.exec(p.updated)?.[1] ?? w.other, p)
  } else {
    const l = CATEGORY_LABELS[category]
    const skip = new Set(
      [category, l?.ko, l?.en, ...(CATEGORY_TAG_ALIASES[category] ?? [])]
        .filter((s): s is string => !!s)
        .map((s) => s.toLowerCase()),
    )
    for (const p of pages) put(p.tags.find((t) => !skip.has(t.toLowerCase())) ?? w.other, p)
  }
  const otherId = otherKey.toLowerCase()
  const other = groups.get(otherId) ?? { key: otherKey, label: w.other, pages: [] }
  groups.delete(otherId)
  let named = [...groups.values()]
  if (category === "work") {
    named.sort((a, b) => (a.key < b.key ? 1 : -1))
  } else {
    for (const g of named.filter((g) => g.pages.length < MIN_GROUP)) other.pages.push(...g.pages)
    named = named
      .filter((g) => g.pages.length >= MIN_GROUP)
      .sort((a, b) => b.pages.length - a.pages.length || (a.key < b.key ? -1 : 1))
  }
  const room = MAX_GROUPS - (other.pages.length > 0 || named.length > MAX_GROUPS ? 1 : 0)
  for (const g of named.slice(room)) other.pages.push(...g.pages)
  named = named.slice(0, room)
  return other.pages.length > 0 ? [...named, other] : named
}

function categoryOrder(categories: string[]): string[] {
  const known = Object.keys(CATEGORY_LABELS)
  return [
    ...known.filter((c) => categories.includes(c)),
    ...categories.filter((c) => !known.includes(c)).sort(),
  ]
}

function buildTop(byCat: Map<string, IndexPage[]>, total: number, lang: string): string {
  const w = words(lang)
  const render = (recent: number, withDesc: boolean): string => {
    const out = [w.topTitle, "", w.note, "", w.total(total)]
    for (const category of categoryOrder([...byCat.keys()])) {
      const pages = byCat.get(category)!
      const { name, desc } = label(category, lang)
      const last = pages[0]?.updated
      out.push("", `## ${name} (${pages.length})`)
      const facts = [withDesc ? desc : "", last ? `${w.updated} ${last}` : "", `${w.list}: index/${category}.md`]
      out.push(facts.filter(Boolean).join(" · "))
      for (const p of pages.slice(0, recent)) out.push(`- [[${p.slug}]] — ${clip(p.title, 40)}`)
    }
    return `${out.join("\n")}\n`
  }
  for (let recent = RECENT; recent >= 0; recent--) {
    const text = render(recent, true)
    if (text.length <= TOP_MAX_CHARS) return text
  }
  const bare = render(0, false)
  if (bare.length <= TOP_MAX_CHARS) return bare
  const cut = bare.slice(0, TOP_MAX_CHARS - 2)
  return `${cut.slice(0, cut.lastIndexOf("\n"))}\n…\n`
}

export function buildIndexFiles(pages: IndexPage[], lang: string): Map<string, string> {
  const w = words(lang)
  const byCat = new Map<string, IndexPage[]>()
  for (const p of pages) {
    const list = byCat.get(p.category) ?? []
    list.push(p)
    byCat.set(p.category, list)
  }
  for (const list of byCat.values()) list.sort(byRecent)

  const out = new Map<string, string>()
  out.set("wiki/index.md", buildTop(byCat, pages.length, lang))

  for (const category of categoryOrder([...byCat.keys()])) {
    const list = byCat.get(category)!
    const { name, desc } = label(category, lang)
    const head = (part: string) => [`# ${name} (${list.length})${part}`, ...(desc ? [desc] : [])]
    if (list.length <= SPLIT_OVER || PARTS_ONLY.has(category)) {
      writeParts(out, `wiki/index/${category}`, head, list.map(pageLine), w)
      continue
    }
    const groups = groupPages(category, list, lang)
    const lines = groups.map((g) => `- ${g.label} (${g.pages.length}) — index/${category}/${g.key}.md`)
    out.set(`wiki/index/${category}.md`, `${[...head(""), "", w.groups, ...lines].join("\n")}\n`)
    for (const g of groups) {
      writeParts(
        out,
        `wiki/index/${category}/${g.key}`,
        (part) => [`# ${name} › ${clip(g.label, 60)} (${g.pages.length})${part}`],
        g.pages.map(pageLine),
        w,
      )
    }
  }
  return out
}

export async function rebuildWikiIndex(
  projectPath: string,
  lang: string,
): Promise<{ written: string[]; removed: string[] }> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const files = buildIndexFiles(await collectIndexPages(root), lang)
  const written: string[] = []
  for (const [rel, text] of files) {
    const abs = `${root}/${rel}`
    let old: string | null = null
    try {
      old = await readFile(abs)
    } catch {
      old = null
    }
    if (old === text) continue
    await writeFileAtomic(abs, text)
    written.push(rel)
  }
  const removed: string[] = []
  let existing: FileNode[] = []
  try {
    existing = await listDirectory(`${root}/wiki/index`)
  } catch {
    existing = []
  }
  const all: FileNode[] = []
  walkFiles(existing, all)
  for (const f of all) {
    if (f.name.startsWith(".")) continue // another rebuild's temp file
    const rel = normalizePath(f.path).slice(root.length + 1)
    if (files.has(rel)) continue
    await deleteFile(normalizePath(f.path))
    removed.push(rel)
  }
  return { written, removed }
}

/** True for the files this module owns: `wiki/index.md` and `wiki/index/**`. */
export function isIndexFilePath(relPath: string): boolean {
  const p = normalizePath(relPath).replace(/^(\.\/|\/)+/, "").toLowerCase()
  return p === "wiki/index.md" || p.startsWith("wiki/index/")
}

/**
 * Rebuild the index in the current output language. A failure is logged,
 * never thrown: the pages are already written, and the next rebuild
 * (after the next change, or at app start) repairs the index.
 */
export function refreshWikiIndex(projectPath: string): Promise<void> {
  // One rebuild per project at a time. A request that arrives while one
  // runs marks it to run once more, so every caller's change is in the
  // index when its promise resolves. (Not the project lock: autoIngest
  // already holds that, and it is not re-entrant.)
  const key = normalizePath(projectPath).replace(/\/+$/, "")
  const current = rebuilds.get(key)
  if (current) {
    current.again = true
    return current.done
  }
  const state = { again: false, done: Promise.resolve() }
  rebuilds.set(key, state)
  state.done = (async () => {
    try {
      do {
        state.again = false
        try {
          await rebuildWikiIndex(key, currentOutputLanguage())
        } catch (err) {
          console.warn("[wiki-index] rebuild failed:", err instanceof Error ? err.message : err)
        }
      } while (state.again)
    } finally {
      rebuilds.delete(key)
    }
  })()
  return state.done
}

const rebuilds = new Map<string, { again: boolean; done: Promise<void> }>()

/**
 * True for a node of a `listDirectory(<project>/wiki)` tree that is index,
 * not a page: the `wiki/index` folder or the top `wiki/index.md`. Walkers
 * skip it. Matching the node (not a substring of any path) keeps a project
 * that itself sits under a folder named `wiki/index` working.
 */
export function isIndexNode(node: { path: string; is_dir: boolean }): boolean {
  const p = normalizePath(node.path).toLowerCase().replace(/\/+$/, "")
  return node.is_dir ? p.endsWith("/wiki/index") : p.endsWith("/wiki/index.md")
}
