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
  notebook_id: string | null
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

export type PullResponse = {
  notes: WireNote[]
  // The highest seq in the page, or the `since` that was sent when the page
  // is empty. An empty pull must not rewind a client to the start.
  cursor: number
  has_more: boolean
}

const CSRF_COOKIE = 'nefix_csrf'
const CSRF_HEADER = 'X-CSRF-Token'

// The server sets this one without HttpOnly precisely so it can be read here
// and echoed back in a header, which is what a cross-site request cannot do.
function csrfToken(): string | null {
  for (const pair of document.cookie.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (name === CSRF_COOKIE) return decodeURIComponent(rest.join('='))
  }

  return null
}

export async function send(
  path: string,
  init?: RequestInit,
  // Login and register only: they run before there is a session, so there is
  // no token to send and the server does not ask for one. Everything else
  // defaults to sending it, so an endpoint added later is covered without
  // anyone having to remember.
  anonymous = false,
): Promise<unknown> {
  const method = init?.method ?? 'GET'
  const headers = new Headers(init?.headers)

  if (!anonymous && method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken()
    // Loudly, and before the request goes out. Sending it without the header
    // produces a 403 that reads like a server fault rather than what it is,
    // which is this client having no readable session.
    if (token === null) {
      throw new Error(`${path}: no CSRF cookie, so this request cannot be sent`)
    }
    headers.set(CSRF_HEADER, token)
  }

  let response: Response
  // Only the transport is guarded. fetch rejects when the request never
  // arrived; every HTTP status resolves, so a 500 read as "offline" would
  // have the UI blame the network for the server.
  try {
    response = await fetch(path, { credentials: 'include', ...init, headers })
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

  // Logout answers 204 with no body, and parsing an empty body rejects.
  if (response.status === 204) return null

  return await response.json()
}

export async function push(notes: PushNote[]): Promise<PushResponse> {
  return (await send('/api/v1/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  })) as PushResponse
}

export async function pull(
  since: number,
  limit: number,
): Promise<PullResponse> {
  const query = new URLSearchParams({
    since: String(since),
    limit: String(limit),
  })
  return (await send(`/api/v1/sync/pull?${query}`)) as PullResponse
}
