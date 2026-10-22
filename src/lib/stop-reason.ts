/**
 * Why a streamed answer ended, read from one SSE line. "length" means the
 * endpoint stopped at max_tokens — for reasoning models (DeepSeek, Qwen,
 * Kimi …) the hidden thinking counts against that budget, so a "length"
 * stop can leave the visible answer cut short or even empty.
 *
 *   OpenAI-style   choices[0].finish_reason   "length"     | other
 *   Anthropic      delta.stop_reason          "max_tokens" | other
 *   Gemini         candidates[0].finishReason "MAX_TOKENS" | other
 */
export type StopReason = "length" | "stop"

export function stopReasonFromLine(line: string): StopReason | null {
  if (!line.startsWith("data:")) return null
  const data = line.slice(5).trim()
  if (!data || data === "[DONE]") return null
  let parsed: {
    choices?: Array<{ finish_reason?: string | null }>
    delta?: { stop_reason?: string | null }
    candidates?: Array<{ finishReason?: string | null }>
  }
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  const reason =
    parsed.choices?.[0]?.finish_reason ?? parsed.delta?.stop_reason ?? parsed.candidates?.[0]?.finishReason ?? null
  if (!reason) return null
  return reason === "length" || reason === "max_tokens" || reason === "MAX_TOKENS" ? "length" : "stop"
}
