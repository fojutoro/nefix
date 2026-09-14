import { db } from '../db/schema.ts'
import { pull, type PullResponse } from './api.ts'
import { notePull } from './debug.ts'
import {
  fromWire,
  fromWireClass,
  fromWireDeadline,
  fromWireNotebook,
} from './push.ts'
import type { PullSummary } from './state.ts'

// One row, in the same database as the notes it describes. In localStorage it
// could be cleared on its own, and the client would then believe it holds
// notes it does not have and never ask for them again.
const CURSOR = 'syncCursor'

const PAGE = 100

// A device that has been away for a term yields instead of blocking the app
// for minutes. The cursor is stored per page, so the next run resumes exactly
// where this one stopped.
const MAX_PAGES = 20

async function readCursor(): Promise<number> {
  const row = await db.meta.get(CURSOR)
  return typeof row?.value === 'number' ? row.value : 0
}

async function applyPage(response: PullResponse): Promise<number> {
  let applied = 0
  // The whole page and its cursor in one transaction, the cursor written
  // last, so the page applies wholly or not at all. Advancing the cursor
  // before the rows are stored is how a crash mid-apply loses them for ever:
  // they are below the cursor, so nothing ever asks for them again and
  // nothing reports it. All four arrays share the one cursor, so they share
  // the one transaction too — storing it after the notes but before the
  // notebooks would leave exactly the split view the single cursor prevents.
  await db.transaction(
    'rw',
    db.classes,
    db.notebooks,
    db.notes,
    db.deadlines,
    db.meta,
    async () => {
      // Classes, then notebooks, then notes, then deadlines, matching the
      // order the server applied them in: a deadline's topics name notes, so
      // the notes are in place before anything points at them.
      for (const remote of response.classes) {
        const local = await db.classes.get(remote.id)
        if (local !== undefined && local.dirty) continue
        await db.classes.put(fromWireClass(remote))
        applied += 1
      }
      for (const remote of response.notebooks) {
        const local = await db.notebooks.get(remote.id)
        if (local !== undefined && local.dirty) continue
        await db.notebooks.put(fromWireNotebook(remote))
        applied += 1
      }
      for (const remote of response.notes) {
        const local = await db.notes.get(remote.id)
        // The one row that must never be written over. A dirty row holds
        // edits the server has not seen; push runs first, so a row still
        // dirty here was edited during this run and the next cycle sends it.
        if (local !== undefined && local.dirty) continue
        // An unknown row and a clean local one take the same path: the
        // server is authoritative for a row with no local changes.
        // `deleted_at` rides along, so a remote soft delete is an ordinary
        // overwrite and is skipped for a dirty row by the same check.
        await db.notes.put(fromWire(remote))
        applied += 1
      }
      for (const remote of response.deadlines) {
        const local = await db.deadlines.get(remote.id)
        if (local !== undefined && local.dirty) continue
        await db.deadlines.put(fromWireDeadline(remote))
        applied += 1
      }
      await db.meta.put({ key: CURSOR, value: response.cursor })
    },
  )
  return applied
}

export async function pullRemoteChanges(): Promise<PullSummary> {
  const summary: PullSummary = { applied: 0, skipped: 0, pages: 0 }
  let since = await readCursor()
  // The cursor this run started from, for the debug panel: a client stuck on
  // a wrong cursor pulls nothing for ever and looks exactly like a server
  // with nothing to give.
  const cursorBefore = since
  const received = { classes: 0, notebooks: 0, notes: 0 }
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await pull(since, PAGE)
    const applied = await applyPage(response)
    const rows =
      response.classes.length +
      response.notebooks.length +
      response.notes.length +
      response.deadlines.length
    received.classes += response.classes.length
    received.notebooks += response.notebooks.length
    received.notes += response.notes.length
    summary.applied += applied
    summary.skipped += rows - applied
    summary.pages += 1
    since = response.cursor
    if (!response.has_more) break
  }
  notePull({ ...received, ...summary, cursorBefore, cursorAfter: since })
  return summary
}
