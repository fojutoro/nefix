import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClass } from '../db/classes.ts'
import { createNote } from '../db/notes.ts'
import { createCollegebook } from '../db/notebooks.ts'
import { db } from '../db/schema.ts'
import type { WireNotebook } from './api.ts'
import {
  beginCycle,
  compareWithServer,
  cycles,
  endCycle,
  localSnapshot,
  notePull,
  notePush,
  resetCycles,
} from './debug.ts'

const CSRF_FIXTURE = 'nefix_csrf=Zm9yLXRlc3Rz'

beforeEach(async () => {
  document.cookie = CSRF_FIXTURE
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
  await db.meta.clear()
  resetCycles()
  vi.unstubAllGlobals()
})

describe('the cycle history', () => {
  it('keeps the last ten and no more, newest first', () => {
    for (let n = 0; n < 13; n += 1) {
      beginCycle()
      notePush({ classes: n, notebooks: 0, notes: 0, accepted: n, conflicted: 0, forbidden: 0, failed: 0 })
      endCycle(null)
    }
    const kept = cycles()
    expect(kept).toHaveLength(10)
    // Newest first, so the panel reads top down without reversing anything.
    expect(kept[0]?.push?.classes).toBe(12)
    expect(kept[9]?.push?.classes).toBe(3)
  })

  it('records what each half of a cycle carried, and the error if there was one', () => {
    beginCycle()
    notePush({ classes: 1, notebooks: 2, notes: 3, accepted: 5, conflicted: 1, forbidden: 0, failed: 0 })
    notePull({ classes: 0, notebooks: 1, notes: 4, applied: 5, skipped: 0, pages: 1, cursorBefore: 7, cursorAfter: 19 })
    endCycle(null)

    const [latest] = cycles()
    expect(latest?.push).toMatchObject({ notebooks: 2, accepted: 5, conflicted: 1 })
    expect(latest?.pull).toMatchObject({ notes: 4, cursorBefore: 7, cursorAfter: 19 })
    expect(latest?.error).toBeNull()
    expect(typeof latest?.at).toBe('number')

    beginCycle()
    endCycle(new Error('HTTP 500'))
    expect(cycles()[0]?.error).toMatchObject({ message: 'HTTP 500' })
    // A cycle that never pushed or pulled says so rather than showing zeroes
    // it never measured.
    expect(cycles()[0]?.push).toBeNull()
  })
})

describe('the local snapshot', () => {
  it('counts what is actually in Dexie, dirty rows included', async () => {
    const cls = await createClass({ name: 'Diskrétna matematika' })
    const book = await createCollegebook('Prednášky', cls.id)
    await createNote({ title: 'Množiny', notebookId: book.id })
    await db.meta.put({ key: 'syncCursor', value: 42 })
    // One of each made clean, so the dirty counts are not just the totals.
    await db.classes.update(cls.id, { dirty: false })

    const snap = await localSnapshot()
    expect(snap.cursor).toBe(42)
    expect(snap.classes).toEqual({ rows: 1, dirty: 0 })
    // The book, plus the general notebook its class was created with.
    expect(snap.notebooks.rows).toBe(2)
    expect(snap.notebooks.dirty).toBe(2)
    // The book's first page, plus the note.
    expect(snap.notes).toEqual({ rows: 2, dirty: 2 })
    expect(snap.dexie).toBe(db.verno)
  })
})

describe('compareWithServer', () => {
  const serve = (notebooks: WireNotebook[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          classes: [],
          notebooks,
          notes: [],
          cursor: 9,
          has_more: false,
        }),
      })),
    )

  const wireNotebook = (id: string, version: number): WireNotebook => ({
    id,
    class_id: null,
    name: 'Prednášky',
    is_general: false,
    kind: 'collegebook',
    settings: null,
    version,
    seq: 3,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T10:00:00.000Z',
    deleted_at: null,
  })

  it('reports rows on one side only and rows whose version differs', async () => {
    const mine = await createCollegebook('Prednášky', null)
    const drifted = await createCollegebook('Cvičenia', null)
    await db.notebooks.update(mine.id, { version: 4 })
    await db.notebooks.update(drifted.id, { version: 2 })

    serve([
      // Same version as local: agreed.
      wireNotebook(mine.id, 4),
      // Local says 2, the server says 6.
      wireNotebook(drifted.id, 6),
      // The server has one this device has never seen.
      wireNotebook('0192f0c1-0000-7000-8000-000000000009', 1),
    ])

    const diff = await compareWithServer()
    expect(diff.onlyOnServer).toBe(1)
    expect(diff.versionDiffers).toBe(1)
    // The two pages belonging to the two books: local rows the server's
    // reply did not contain.
    expect(diff.onlyLocal).toBe(2)
    expect(diff.serverRows).toBe(3)
  })

  // The whole point of the button. A diagnostic that writes is a diagnostic
  // that changes the thing it was asked to measure.
  it('writes nothing at all', async () => {
    const book = await createCollegebook('Prednášky', null)
    await db.meta.put({ key: 'syncCursor', value: 42 })
    serve([wireNotebook(book.id, 99), wireNotebook('0192f0c1-0000-7000-8000-000000000009', 1)])

    const before = {
      classes: await db.classes.toArray(),
      notebooks: await db.notebooks.toArray(),
      notes: await db.notes.toArray(),
      meta: await db.meta.toArray(),
    }

    await compareWithServer()

    expect(await db.classes.toArray()).toEqual(before.classes)
    // Neither the drifted version nor the unseen row landed.
    expect(await db.notebooks.toArray()).toEqual(before.notebooks)
    expect(await db.notes.toArray()).toEqual(before.notes)
    // And the cursor is untouched, which a pull would have moved to 9.
    expect(await db.meta.toArray()).toEqual(before.meta)
  })
})
