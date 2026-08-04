// Components never call the API. From phase 4, `src/sync/` is the only module
// that knows the server exists; this file is a temporary exception whose whole
// purpose is to prove the dev proxy reaches the Go process.

export type Health = {
  status: string
  version: string
  commit: string
}

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch('/health', { signal })
  if (!response.ok) {
    throw new Error(`/health responded ${response.status}`)
  }
  return (await response.json()) as Health
}
