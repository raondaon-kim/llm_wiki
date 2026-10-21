/**
 * The index files are built by `wiki-index.ts` only. Ingest must ignore any
 * FILE block the LLM emits for `wiki/index.md` or `wiki/index/**`, and must
 * rebuild the index from the pages once it has written them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

let pendingResponses: string[] = []
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _msgs, cb) => {
    const resp = pendingResponses.shift() ?? ""
    cb.onToken(resp)
    cb.onDone()
  }),
}))

import { autoIngest, executeIngestWrites } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"

const LLM = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
} as const

const GENERATION = [
  "---FILE: wiki/index.md---",
  "# LLM WROTE THIS INDEX",
  "- [[ghost-page]]",
  "---END FILE---",
  "",
  "---FILE: wiki/index/concepts.md---",
  "LLM WROTE THIS SUB INDEX",
  "---END FILE---",
  "",
  "---FILE: wiki/concepts/rope.md---",
  "---",
  "title: Rotary Position Embedding",
  "tags: [positional-encoding]",
  "sources: [rope-paper.md]",
  "updated: 2026-10-21",
  "---",
  "",
  "# Rotary Position Embedding",
  "",
  "RoPE rotates pairs of dimensions in queries and keys.",
  "---END FILE---",
].join("\n")

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  pendingResponses = []
  tmp = await createTempProject("ingest-writes")
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })
  useWikiStore.setState({
    project: { name: "t", path: tmp.path, createdAt: 0, purposeText: "", fileTree: [] } as unknown as ReturnType<
      typeof useWikiStore.getState
    >["project"],
    outputLanguage: "English",
  })
  useWikiStore.getState().setLlmConfig({ ...LLM })
  await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nDeep learning notes.\n")
  await writeFileRaw(`${tmp.path}/schema.md`, "# Schema\n")
  await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n\n- [[stale-entry]]\n")
  await writeFileRaw(
    `${tmp.path}/raw/sources/rope-paper.md`,
    "# Rotary Position Embedding\n\nRoPE encodes position by rotating pairs of dimensions in query and key vectors.\n",
  )
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("autoIngest and the index", () => {
  it("writeFileBlocks ignores FILE blocks for wiki/index.md and wiki/index/**", async () => {
    pendingResponses = ["## Key Concepts\n- RoPE", GENERATION]
    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/rope-paper.md`, { ...LLM })
    expect(written.some((p) => p.endsWith("wiki/concepts/rope.md"))).toBe(true)
    expect(written.some((p) => /wiki\/index(\.md|\/)/.test(p))).toBe(false)
    expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).not.toContain("LLM WROTE")
    expect(await readFileRaw(`${tmp.path}/wiki/index/concepts.md`)).not.toContain("LLM WROTE")
  })

  it("a successful autoIngest rebuilds the index so it lists the new pages", async () => {
    pendingResponses = ["## Key Concepts\n- RoPE", GENERATION]
    await autoIngest(tmp.path, `${tmp.path}/raw/sources/rope-paper.md`, { ...LLM })
    const top = await readFileRaw(`${tmp.path}/wiki/index.md`)
    expect(top).toContain("[[rope]]")
    expect(top).not.toContain("stale-entry")
    expect(top).not.toContain("ghost-page")
    expect(await readFileRaw(`${tmp.path}/wiki/index/concepts.md`)).toContain(
      "- [[rope]] — Rotary Position Embedding — RoPE rotates pairs of dimensions in queries and keys.",
    )
  })
})

describe("executeIngestWrites and the index", () => {
  it("executeIngestWrites ignores index blocks", async () => {
    useChatStore.setState({
      messages: [{ id: "1", role: "user", content: "Discuss RoPE", timestamp: 0 }] as unknown as ReturnType<
        typeof useChatStore.getState
      >["messages"],
    })
    pendingResponses = [GENERATION]
    const written = await executeIngestWrites(tmp.path, { ...LLM })
    expect(written.some((p) => p.endsWith("wiki/concepts/rope.md"))).toBe(true)
    expect(written.some((p) => /wiki\/index(\.md|\/)/.test(p))).toBe(false)
    const top = await readFileRaw(`${tmp.path}/wiki/index.md`)
    expect(top).not.toContain("LLM WROTE")
    expect(top).toContain("[[rope]]")
    expect(await fileExists(`${tmp.path}/wiki/index/concepts.md`)).toBe(true)
  })
})
