import { db, searchTextOf, type Note } from '../db/schema.ts'
import { uuidv7 } from '../db/uuid.ts'
import i18n from '../i18n/index.ts'
import {
  OfflineError,
  UnauthenticatedError,
  push,
  type PushNote,
  type PushResult,
  type WireNote,
} from './api.ts'
import { syncState, type PushSummary, type SyncStatus } from './state.ts'

// The server answers a larger batch with 413.
const BATCH = 100

// Two overlapping runs would send the same notes twice, and the second would
// conflict against the first's write — forking every note it touched.
let running = false

const toWire = (note: Note): PushNote => ({
  id: note.id,
  class_id: note.classId,
  title: note.title,
  body_md: note.bodyMd,
  visibility: note.visibility,
  forked_from_id: note.forkedFromId,
  version: note.version,
  // Already RFC 3339: every writer stores toISOString().
  deleted_at: note.deletedAt,
})

const fromWire = (server: WireNote): Note => ({
  id: server.id,
  classId: server.class_id,
  title: server.title,
  bodyMd: server.body_md,
  searchText: searchTextOf(server.title, server.body_md),
  visibility: server.visibility,
  createdAt: server.created_at,
  updatedAt: server.updated_at,
  deletedAt: server.deleted_at,
  forkedFromId: server.forked_from_id,
  version: server.version,
  dirty: false,
  // The server's clock, not this device's. They are then comparable on the
  // same note, and a device with a wrong clock cannot claim to be ahead.
  syncedAt: server.updated_at,
})

async function applyAccepted(sent: Note, server: WireNote): Promise<void> {
  await db.transaction('rw', db.notes, async () => {
    const current = await db.notes.get(sent.id)
    if (current === undefined) return
    await db.notes.update(sent.id, {
      // Stored even when the note moved on, because the server does hold
      // this version. Sending the old one next time would conflict the user
      // against their own write.
      version: server.version,
      syncedAt: server.updated_at,
      // An edit that landed while the request was in flight is not on the
      // server. Clearing the flag here is how the last keystrokes before a
      // sync get dropped, so the flag survives and the next run sends them.
      dirty: current.updatedAt !== sent.updatedAt,
    })
  })
}

async function applyConflict(sent: Note, server: WireNote): Promise<void> {
  const marker = i18n.t('sync.olderVersion')
  await db.transaction('rw', db.notes, async () => {
    // Re-read rather than copy `sent`: an edit made during the request belongs
    // in the kept copy, since the row it was written to is about to be
    // overwritten by the server's.
    const local = await db.notes.get(sent.id)
    if (local === undefined) return
    const title = `${local.title} ${marker}`
    await db.notes.add({
      ...local,
      id: uuidv7(),
      title,
      searchText: searchTextOf(title, local.bodyMd),
      // A note the server has never had, so it pushes as a creation.
      version: 0,
      dirty: true,
      syncedAt: null,
    })
    await db.notes.put(fromWire(server))
  })
}

async function applyResult(
  sent: Note,
  result: PushResult,
  summary: PushSummary,
): Promise<void> {
  if (result.status === 'accepted' && result.note !== undefined) {
    await applyAccepted(sent, result.note)
    summary.pushed += 1
  } else if (result.status === 'conflict' && result.note !== undefined) {
    await applyConflict(sent, result.note)
    summary.conflicted += 1
  } else if (result.status === 'forbidden') {
    // Impossible for one's own note, so the local database holds an id that
    // belongs to somebody else. Left dirty and counted rather than dropped:
    // silently is the one way this must not fail.
    console.warn(`sync: the server refuses note ${sent.id} as another user's`)
    summary.forbidden += 1
  }
}

function statusFor(error: unknown): SyncStatus {
  if (error instanceof OfflineError) return 'offline'
  // The queue simply stops draining until they sign in again. Nothing is
  // cleared, nothing redirects, and someone mid-sentence sees no change.
  if (error instanceof UnauthenticatedError) return 'unauthenticated'
  return 'error'
}

export async function pushDirtyNotes(): Promise<PushSummary> {
  const summary: PushSummary = {
    pushed: 0,
    conflicted: 0,
    forbidden: 0,
    failed: 0,
  }
  if (running) return summary
  running = true
  syncState.setState({ status: 'syncing' })

  let queued = 0
  let handled = 0
  try {
    // dirty is a boolean, so it is absent from its index and this filters in
    // memory. See the note on declareSchema.
    const dirty = await db.notes.filter((note) => note.dirty).toArray()
    queued = dirty.length
    for (let start = 0; start < dirty.length; start += BATCH) {
      const batch = dirty.slice(start, start + BATCH)
      const { results } = await push(batch.map(toWire))
      for (const result of results) {
        const sent = batch.find((note) => note.id === result.id)
        if (sent === undefined) continue
        await applyResult(sent, result, summary)
        handled += 1
      }
    }
    syncState.setState({
      status: 'idle',
      lastSummary: summary,
      lastSyncedAt: Date.now(),
      lastError: null,
    })
  } catch (error) {
    // Everything the run never got to. Those notes are still dirty, so the
    // next run picks them up; the count is what makes that visible.
    summary.failed = queued - handled
    syncState.setState({
      status: statusFor(error),
      lastSummary: summary,
      lastError: error instanceof Error ? error : new Error(String(error)),
    })
  } finally {
    running = false
  }
  return summary
}
