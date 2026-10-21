/**
 * The API's POST /projects/:id/index/rebuild emits `wiki-index://rebuild`;
 * the WebView rebuilds when the event names the open project.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const listeners: Record<string, (event: { payload: unknown }) => void> = {}
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners[name] = cb
    return () => delete listeners[name]
  }),
}))
const rebuild = vi.fn(async () => ({ written: [], removed: [] }))
vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async () => []),
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => undefined),
  deleteFile: vi.fn(async () => undefined),
}))

import * as wikiIndex from "./wiki-index"

beforeEach(() => {
  rebuild.mockClear()
})

describe("listenIndexRebuild", () => {
  it("rebuilds the open project when the event names it, and ignores other projects", async () => {
    const refresh = vi.fn(async () => undefined)
    const unlisten = await wikiIndex.listenIndexRebuild(() => ({ id: "p-1", path: "/w" }), refresh)
    listeners["wiki-index://rebuild"]({ payload: { projectId: "p-2" } })
    expect(refresh).not.toHaveBeenCalled()
    listeners["wiki-index://rebuild"]({ payload: { projectId: "p-1" } })
    expect(refresh).toHaveBeenCalledWith("/w")
    unlisten()
    expect(listeners["wiki-index://rebuild"]).toBeUndefined()
  })

  it("does nothing without an open project", async () => {
    const refresh = vi.fn(async () => undefined)
    await wikiIndex.listenIndexRebuild(() => null, refresh)
    listeners["wiki-index://rebuild"]({ payload: { projectId: "p-1" } })
    expect(refresh).not.toHaveBeenCalled()
  })
})
