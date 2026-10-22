import { describe, it, expect, vi } from "vitest"

const sse = (lines: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(lines.map((l) => `${l}\n\n`).join("")))
        c.close()
      },
    }),
    { status: 200 },
  )
let next: Response
vi.mock("./tauri-fetch", () => ({
  getHttpFetch: async () => async () => next,
  isFetchNetworkError: () => false,
}))

import { streamChat } from "./llm-client"

const CFG = { provider: "openai", apiKey: "k", model: "m", ollamaUrl: "", customEndpoint: "", maxContextSize: 128000 } as never

async function run() {
  let text = ""
  const reasons: string[] = []
  await streamChat(CFG, [{ role: "user", content: "hi" }], {
    onToken: (t) => {
      text += t
    },
    onStopReason: (r) => reasons.push(r),
    onDone: () => {},
    onError: (e) => {
      throw e
    },
  })
  return { text, reasons }
}

describe("streamChat reports why the answer ended", () => {
  it("reports 'length' when the endpoint stopped at max_tokens", async () => {
    next = sse([
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
      "data: [DONE]",
    ])
    expect(await run()).toEqual({ text: "Hel", reasons: ["length"] })
  })

  it("reports 'stop' for a normal end", async () => {
    next = sse([
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ])
    expect(await run()).toEqual({ text: "Hello", reasons: ["stop"] })
  })
})
