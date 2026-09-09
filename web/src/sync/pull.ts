import { db } from '../db/schema.ts'
import { pull, type WireNote } from './api.ts'
import { fromWire } from './push.ts'
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

async function applyPage(notes: WireNote[], cursor: number): Promise<number> {
  let applied = 0
  // The page and its cursor in one transaction, the cursor written last, so
  // the page applies wholly or not at all. Advancing the cursor before the
  // notes are stored is how a crash mid-apply loses them for ever: they are
  // below the cursor, so nothing ever asks for them again and nothing
  // reports it.
  await db.transaction('rw', db.notes, db.meta, async () => {
    for (const remote of notes) {
      const local = await db.notes.get(remote.id)
      // The one row that must never be written over. A dirty note holds
      // edits the server has not seen; push runs first, so a note still
      // dirty here was edited during this run and the next cycle sends it.
      if (local !== undefined && local.dirty) continue
      // An unknown note and a clean local one take the same path: the server
      // is authoritative for a note with no local changes. `deleted_at` rides
      // along, so a remote soft delete is an ordinary overwrite and is
      // skipped for a dirty note by the same check.
      await db.notes.put(fromWire(remote))
      applied += 1
    }
    await db.meta.put({ key: CURSOR, value: cursor })
  })
  return applied
}

export async function pullRemoteChanges(): Promise<PullSummary> {
  const summary: PullSummary = { applied: 0, skipped: 0, pages: 0 }
  let since = await readCursor()
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await pull(since, PAGE)
    const applied = await applyPage(response.notes, response.cursor)
    summary.applied += applied
    summary.skipped += response.notes.length - applied
    summary.pages += 1
    since = response.cursor
    if (!response.has_more) break
  }
  return summary
}
