import {
  db,
  searchTextOf,
  type Class,
  type Note,
  type Notebook,
} from '../db/schema.ts'
import { uuidv7 } from '../db/uuid.ts'
import i18n from '../i18n/index.ts'
import {
  push,
  type PushClass,
  type PushNote,
  type PushNotebook,
  type PushResult,
  type WireClass,
  type WireNote,
  type WireNotebook,
} from './api.ts'
import { statusFor, syncState, type PushSummary } from './state.ts'

// The server answers a larger batch with 413.
const BATCH = 100

// Two overlapping runs would send the same rows twice, and the second would
// conflict against the first's write — forking every note it touched.
let running = false

const toWire = (note: Note): PushNote => ({
  id: note.id,
  class_id: note.classId,
  notebook_id: note.notebookId,
  title: note.title,
  body_md: note.bodyMd,
  visibility: note.visibility,
  forked_from_id: note.forkedFromId,
  version: note.version,
  // Already RFC 3339: every writer stores toISOString().
  deleted_at: note.deletedAt,
})

const toWireClass = (row: Class): PushClass => ({
  id: row.id,
  name: row.name,
  code: row.code,
  colour: row.colour,
  semester: row.semester,
  archived_at: row.archivedAt,
  version: row.version,
  deleted_at: row.deletedAt,
})

const toWireNotebook = (row: Notebook): PushNotebook => ({
  id: row.id,
  class_id: row.classId,
  name: row.name,
  is_general: row.isGeneral,
  version: row.version,
  deleted_at: row.deletedAt,
})

// Shared with the pull path. Both halves write the server's copy into a
// local row, and there has to be exactly one function doing it or the two
// drift apart on the next field either of them gains.
export const fromWire = (server: WireNote): Note => ({
  id: server.id,
  classId: server.class_id,
  notebookId: server.notebook_id,
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

export const fromWireClass = (server: WireClass): Class => ({
  id: server.id,
  name: server.name,
  code: server.code,
  colour: server.colour,
  semester: server.semester,
  archivedAt: server.archived_at,
  createdAt: server.created_at,
  updatedAt: server.updated_at,
  deletedAt: server.deleted_at,
  version: server.version,
  dirty: false,
  syncedAt: server.updated_at,
})

export const fromWireNotebook = (server: WireNotebook): Notebook => ({
  id: server.id,
  classId: server.class_id,
  name: server.name,
  isGeneral: server.is_general,
  createdAt: server.created_at,
  updatedAt: server.updated_at,
  deletedAt: server.deleted_at,
  version: server.version,
  dirty: false,
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

// Classes and notebooks resolve a conflict by taking the server's copy:
// last write wins, no fork, no marker. This deliberately differs from the
// note path above, and the difference is the decision rather than an
// oversight — a fork of a notebook name is meaningless, and two devices
// renaming one notebook is not a case worth preserving both sides of. Do
// not "fix" the two into agreement.
async function applyClassResult(
  sent: Class,
  result: PushResult,
  summary: PushSummary,
): Promise<void> {
  const server = result.class
  if (result.status === 'accepted' && server !== undefined) {
    await db.transaction('rw', db.classes, async () => {
      const current = await db.classes.get(sent.id)
      if (current === undefined) return
      await db.classes.update(sent.id, {
        version: server.version,
        syncedAt: server.updated_at,
        // An edit that landed while the request was in flight is not on the
        // server, so the flag survives and the next run sends it.
        dirty: current.updatedAt !== sent.updatedAt,
      })
    })
    summary.pushed += 1
  } else if (result.status === 'conflict' && server !== undefined) {
    await db.classes.put(fromWireClass(server))
    summary.conflicted += 1
  } else if (result.status === 'forbidden') {
    console.warn(`sync: the server refuses class ${sent.id} as another user's`)
    summary.forbidden += 1
  }
}

async function applyNotebookResult(
  sent: Notebook,
  result: PushResult,
  summary: PushSummary,
): Promise<void> {
  const server = result.notebook
  if (result.status === 'accepted' && server !== undefined) {
    await db.transaction('rw', db.notebooks, async () => {
      const current = await db.notebooks.get(sent.id)
      if (current === undefined) return
      await db.notebooks.update(sent.id, {
        version: server.version,
        syncedAt: server.updated_at,
        dirty: current.updatedAt !== sent.updatedAt,
      })
    })
    summary.pushed += 1
  } else if (result.status === 'conflict' && server !== undefined) {
    // Last write wins. See applyClassResult.
    await db.notebooks.put(fromWireNotebook(server))
    summary.conflicted += 1
  } else if (result.status === 'forbidden') {
    console.warn(
      `sync: the server refuses notebook ${sent.id} as another user's`,
    )
    summary.forbidden += 1
  }
}

async function applyNoteResult(
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

type Batch = {
  classes: Class[]
  notebooks: Notebook[]
  notes: Note[]
}

// `kind` and not which field came back populated: a forbidden result carries
// no row at all, and every other way of telling the three apart guesses.
async function applyResult(
  batch: Batch,
  result: PushResult,
  summary: PushSummary,
): Promise<boolean> {
  if (result.kind === 'class') {
    const sent = batch.classes.find((row) => row.id === result.id)
    if (sent === undefined) return false
    await applyClassResult(sent, result, summary)
    return true
  }
  if (result.kind === 'notebook') {
    const sent = batch.notebooks.find((row) => row.id === result.id)
    if (sent === undefined) return false
    await applyNotebookResult(sent, result, summary)
    return true
  }
  const sent = batch.notes.find((row) => row.id === result.id)
  if (sent === undefined) return false
  await applyNoteResult(sent, result, summary)
  return true
}

export async function pushDirtyRows(): Promise<PushSummary> {
  const summary: PushSummary = {
    pushed: 0,
    conflicted: 0,
    forbidden: 0,
    failed: 0,
  }
  if (running) return summary
  running = true

  let queued = 0
  let handled = 0
  try {
    // Inside the try, because publishing the status notifies subscribers and
    // one of them can throw. Outside it, that throw would strand the guard
    // and every later push would return having sent nothing, silently.
    syncState.setState({ status: 'syncing' })
    // dirty is a boolean, so it is absent from every index and these filter
    // in memory. See the note on declareSchema.
    const classes = await db.classes.filter((row) => row.dirty).toArray()
    const notebooks = await db.notebooks.filter((row) => row.dirty).toArray()
    const notes = await db.notes.filter((row) => row.dirty).toArray()
    queued = classes.length + notebooks.length + notes.length

    // Each array is capped at a hundred on its own, so the number of
    // requests is set by the longest of the three rather than by their
    // total. A class and its notebook therefore travel together in the
    // first request instead of the notebook waiting for a full page of
    // classes to drain ahead of it.
    const requests = Math.ceil(
      Math.max(classes.length, notebooks.length, notes.length) / BATCH,
    )
    for (let index = 0; index < requests; index += 1) {
      const from = index * BATCH
      const batch: Batch = {
        classes: classes.slice(from, from + BATCH),
        notebooks: notebooks.slice(from, from + BATCH),
        notes: notes.slice(from, from + BATCH),
      }
      const { results } = await push({
        classes: batch.classes.map(toWireClass),
        notebooks: batch.notebooks.map(toWireNotebook),
        notes: batch.notes.map(toWire),
      })
      for (const result of results) {
        if (await applyResult(batch, result, summary)) handled += 1
      }
    }
    syncState.setState({
      status: 'idle',
      lastSummary: summary,
      lastSyncedAt: Date.now(),
      lastError: null,
    })
  } catch (error) {
    // Everything the run never got to. Those rows are still dirty, so the
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
