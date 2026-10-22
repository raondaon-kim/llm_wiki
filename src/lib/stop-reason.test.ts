import { describe, it, expect } from "vitest"
import { stopReasonFromLine } from "./stop-reason"

describe("stopReasonFromLine — why a streamed answer ended", () => {
  it("OpenAI-style finish_reason 'length' is the token limit", () => {
    expect(stopReasonFromLine('data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}')).toBe("length")
  })

  it("OpenAI-style finish_reason 'stop' is a normal end", () => {
    expect(stopReasonFromLine('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}')).toBe("stop")
  })

  it("a chunk without a finish_reason says nothing", () => {
    expect(stopReasonFromLine('data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}')).toBeNull()
  })

  it("Anthropic message_delta stop_reason 'max_tokens' is the token limit", () => {
    expect(stopReasonFromLine('data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}')).toBe("length")
    expect(stopReasonFromLine('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}')).toBe("stop")
  })

  it("Gemini finishReason 'MAX_TOKENS' is the token limit", () => {
    expect(stopReasonFromLine('data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}')).toBe("length")
    expect(stopReasonFromLine('data: {"candidates":[{"finishReason":"STOP"}]}')).toBe("stop")
  })

  it("[DONE], comments and broken JSON say nothing", () => {
    expect(stopReasonFromLine("data: [DONE]")).toBeNull()
    expect(stopReasonFromLine(": keep-alive")).toBeNull()
    expect(stopReasonFromLine('data: {"choices":[{"finish_reason":"len')).toBeNull()
  })
})
