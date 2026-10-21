/**
 * The part of the wiki index that goes into an LLM prompt.
 *
 * The whole index can be far larger than a prompt should carry, so a
 * prompt gets the top index (`wiki/index.md`, at most 4,000 chars) plus
 * the page lines from `wiki/index/**` that share the most words with the
 * question or source text, within the caller's budget.
 */
import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "./path-utils"
import { tokenizeQuery } from "./search"

const TRIM_MARK = "\n\n[...index trimmed to relevant entries...]"
const OVERVIEW_MARK = "\n\n[...overview trimmed...]"
const HANGUL = /[가-힣]/

/**
 * Keep `##` lines and lines containing a query token, in order, until the
 * budget is spent. Returns `raw` unchanged when it already fits.
 */
export function trimIndexByRelevance(raw: string, query: string, budgetChars: number): string {
  if (raw.length <= budgetChars) return raw
  // the cut is marked, and the mark counts against the budget too
  const limit = budgetChars - TRIM_MARK.length
  if (limit <= 0) return ""
  const tokens = tokenizeQuery(query)
  const kept: string[] = []
  let size = 0
  for (const line of raw.split("\n")) {
    const isHeader = line.startsWith("##")
    const lower = line.toLowerCase()
    const isRelevant = tokens.some((t) => lower.includes(t))
    if ((isHeader || isRelevant) && size + line.length + 1 <= limit) {
      kept.push(line)
      size += line.length + 1
    }
  }
  let out = kept.join("\n")
  if (out.length < raw.length) out += TRIM_MARK
  return out
}

/**
 * Words used to compare a line with the query. Korean words carry
 * particles (에듀테크는, 에듀테크를), so Hangul words also contribute their
 * two-letter pieces.
 */
function wordsOf(text: string): Set<string> {
  const out = new Set<string>()
  for (const token of tokenizeQuery(text)) {
    out.add(token)
    if (!HANGUL.test(token)) continue
    const chars = [...token].filter((c) => HANGUL.test(c))
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
  }
  return out
}

function flattenFiles(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n.is_dir) flattenFiles(n.children ?? [], out)
    else if (n.name.toLowerCase().endsWith(".md")) out.push(n)
  }
  return out
}

const PAGE_LINE = /^- \[\[([^\]|]+)/

export async function selectIndexContext(
  projectPath: string,
  queryText: string,
  budgetChars: number,
): Promise<string> {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  let top = ""
  try {
    top = await readFile(`${pp}/wiki/index.md`)
  } catch {
    return ""
  }
  if (!top.trim()) return ""
  if (top.length >= budgetChars) return trimIndexByRelevance(top, queryText, budgetChars)

  let files: FileNode[] = []
  try {
    files = flattenFiles(await listDirectory(`${pp}/wiki/index`))
  } catch {
    files = []
  }
  const query = wordsOf(queryText)
  if (files.length === 0 || query.size === 0) return top

  const seen = new Set<string>()
  for (const m of top.matchAll(/\[\[([^\]|]+)/g)) seen.add(m[1])
  const candidates: Array<{ line: string; score: number; order: number }> = []
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const f of files) {
    let text: string
    try {
      text = await readFile(normalizePath(f.path))
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const slug = PAGE_LINE.exec(line)?.[1]
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      let score = 0
      for (const w of wordsOf(line)) if (query.has(w)) score++
      if (score > 0) candidates.push({ line, score, order: candidates.length })
    }
  }
  if (candidates.length === 0) return top

  candidates.sort((a, b) => b.score - a.score || a.order - b.order)
  let out = `${top.trimEnd()}\n\n## Relevant pages\n`
  let added = 0
  for (const c of candidates) {
    if (out.length + c.line.length + 1 > budgetChars) continue
    out += `${c.line}\n`
    added++
  }
  return added > 0 ? out : top
}

/** Cap the overview a prompt carries; it is rewritten whole on each ingest. */
export function capOverview(text: string, max = 6000): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - OVERVIEW_MARK.length)
  const lineEnd = cut.lastIndexOf("\n")
  return `${lineEnd > max / 2 ? cut.slice(0, lineEnd) : cut}${OVERVIEW_MARK}`
}
