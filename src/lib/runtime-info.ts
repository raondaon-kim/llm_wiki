import { invoke } from "@tauri-apps/api/core"

export interface RuntimeInfo {
  managed: boolean
  clipPort: number
  apiPort: number
}

const FALLBACK: RuntimeInfo = { managed: false, clipPort: 19827, apiPort: 19828 }
let cached: Promise<RuntimeInfo> | null = null

/** how this process was started: managed by GenOffice or not, and its local ports */
export function getRuntimeInfo(): Promise<RuntimeInfo> {
  cached ??= invoke<RuntimeInfo>("runtime_info").catch(() => FALLBACK)
  return cached
}

export async function clipUrl(path: string): Promise<string> {
  const { clipPort } = await getRuntimeInfo()
  return `http://127.0.0.1:${clipPort}${path}`
}
