/**
 * Reasoning models spend hidden thinking tokens inside max_tokens. When a
 * stage stops at the token limit, ingest asks again with twice the budget
 * (analysis 8K -> 16K -> 32K, generation 16K -> 32K -> 64K). A provider that
 * refuses the larger budget keeps the previous answer, as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

type Reply = { text?: string; stop?: "length" | "stop"; error?: string }
let replies: Reply[] = []
const budgets: number[] = []
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _msgs, cb, _signal, overrides) => {
    budgets.push(overrides?.max_tokens)
    const r = replies.shift() ?? { text: "" }
    if (r.error) {
      cb.onError(new Error(r.error))
      return
    }
    cb.onToken(r.text ?? "")
    cb.onStopReason?.(r.stop ?? "stop")
    cb.onDone()
  }),
}))

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"

const LLM = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
} as const

const page = (slug: string, title: string) =>
  [
    `---FILE: wiki/concepts/${slug}.md---`,
    "---",
    `title: ${title}`,
    "sources: [rope-paper.md]",
    "---",
    "",
    `# ${title}`,
    "",
    `${title} body.`,
    "---END FILE---",
    "",
  ].join("\n")
const unclosed = "---FILE: wiki/overview.md---\n---\ntitle: Overview\n---\n\n# Overview\n\nThe wiki cov"

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  replies = []
  budgets.length = 0
  tmp = await createTempProject("ingest-budget")
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useWikiStore.setState({
    project: { name: "t", path: tmp.path, createdAt: 0, purposeText: "", fileTree: [] } as unknown as ReturnType<
      typeof useWikiStore.getState
    >["project"],
    outputLanguage: "English",
  })
  useWikiStore.getState().setLlmConfig({ ...LLM })
  await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n")
  await writeFileRaw(`${tmp.path}/schema.md`, "# Schema\n")
  await writeFileRaw(`${tmp.path}/raw/sources/rope-paper.md`, "# RoPE\n\nRoPE rotates pairs of dimensions.\n")
})

afterEach(async () => {
  await tmp.cleanup()
})

const ingest = () => autoIngest(tmp.path, `${tmp.path}/raw/sources/rope-paper.md`, { ...LLM })
const lastItem = () => {
  const items = useActivityStore.getState().items
  return items[items.length - 1]
}
const lastDetail = () => lastItem()?.detail ?? ""

describe("ingest asks again with a larger budget after the token limit", () => {
  it("a generation cut at the limit is asked again with twice the budget and the full answer is written", async () => {
    replies = [
      { text: "## Key Concepts\n- RoPE" },
      { text: page("rope", "RoPE") + unclosed, stop: "length" },
      { text: page("rope", "RoPE") + page("overview-test", "Overview Test") },
    ]
    await ingest()
    expect(budgets).toEqual([8192, 16384, 32768])
    expect(await fileExists(`${tmp.path}/wiki/concepts/overview-test.md`)).toBe(true)
  })

  it("an analysis cut at the limit is asked again with twice its budget", async () => {
    replies = [
      { text: "## Key Concepts\n- Ro", stop: "length" },
      { text: "## Key Concepts\n- RoPE\n- rotation" },
      { text: page("rope", "RoPE") },
    ]
    await ingest()
    expect(budgets).toEqual([8192, 16384, 16384])
    expect(await fileExists(`${tmp.path}/wiki/concepts/rope.md`)).toBe(true)
  })

  it("a provider that refuses the larger budget keeps the earlier answer", async () => {
    replies = [
      { text: "## Key Concepts\n- RoPE" },
      { text: page("rope", "RoPE") + unclosed, stop: "length" },
      { error: "HTTP 400: max_tokens is too large: 32768. This model supports at most 16384 completion tokens" },
    ]
    const written = await ingest()
    expect(budgets).toEqual([8192, 16384, 32768])
    expect(written.some((p) => p.endsWith("wiki/concepts/rope.md"))).toBe(true)
    expect(lastItem()?.status).not.toBe("error")
  })

  it("still cut at the largest budget: complete pages are written and the activity says the output was cut", async () => {
    replies = [
      { text: "## Key Concepts\n- RoPE" },
      { text: page("rope", "RoPE") + unclosed, stop: "length" },
      { text: page("rope", "RoPE") + unclosed, stop: "length" },
      { text: page("rope", "RoPE") + unclosed, stop: "length" },
    ]
    await ingest()
    expect(budgets).toEqual([8192, 16384, 32768, 65536])
    expect(await readFileRaw(`${tmp.path}/wiki/concepts/rope.md`)).toContain("RoPE body.")
    expect(lastDetail()).toMatch(/token limit/i)
  })

  it("a normal answer is asked once, with today's budgets", async () => {
    replies = [{ text: "## Key Concepts\n- RoPE" }, { text: page("rope", "RoPE") }]
    await ingest()
    expect(budgets).toEqual([8192, 16384])
  })
})
