export class OfflineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfflineError'
  }
}

export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnauthenticatedError'
  }
}

export class ServerError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ServerError'
    this.status = status
  }
}

export type Visibility = 'private' | 'faculty' | 'public'

// What the client sends. `version` is the version it last saw, 0 for a note
// the server has never had, and it is never invented.
export type PushNote = {
  id: string
  class_id: string | null
  title: string
  body_md: string
  visibility: Visibility
  forked_from_id: string | null
  version: number
  deleted_at: string | null
}

// What the server sends back: a PushNote plus the two fields only it may
// assign and the timestamps it stores.
export type WireNote = PushNote & {
  version: number
  seq: number
  created_at: string
  updated_at: string
}

export type PushResult = {
  id: string
  status: 'accepted' | 'conflict' | 'forbidden'
  // Absent on forbidden: a client that guessed an id learns only that it may
  // not write there.
  note?: WireNote
}

export type PushRequest = {
  notes: PushNote[]
}

export type PushResponse = {
  results: PushResult[]
}

export async function push(notes: PushNote[]): Promise<PushResponse> {
  let response: Response
  // Only the transport is guarded. fetch rejects when the request never
  // arrived; every HTTP status resolves, so a 500 read as "offline" would
  // have the UI blame the network for the server.
  try {
    response = await fetch('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ notes }),
    })
  } catch (error) {
    throw new OfflineError(
      error instanceof Error ? error.message : 'network unreachable',
    )
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown
    }
    const message =
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
    if (response.status === 401) throw new UnauthenticatedError(message)
    throw new ServerError(response.status, message)
  }

  return (await response.json()) as PushResponse
}
