import { beforeEach, describe, expect, it, vi } from "vitest"

const invoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

describe("runtime info", () => {
  beforeEach(() => {
    invoke.mockReset()
    vi.resetModules()
  })

  it("asks the backend once and builds clip urls from its port", async () => {
    invoke.mockResolvedValue({ managed: true, clipPort: 51111, apiPort: 51112 })
    const { getRuntimeInfo, clipUrl } = await import("./runtime-info")
    expect((await getRuntimeInfo()).managed).toBe(true)
    expect(await clipUrl("/project")).toBe("http://127.0.0.1:51111/project")
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("falls back to the default ports when the backend cannot answer", async () => {
    invoke.mockRejectedValue(new Error("no tauri"))
    const { getRuntimeInfo } = await import("./runtime-info")
    expect(await getRuntimeInfo()).toEqual({ managed: false, clipPort: 19827, apiPort: 19828 })
  })
})
