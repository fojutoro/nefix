import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNote } from '../db/notes.ts'
import { db, type Note } from '../db/schema.ts'
import { createClass } from '../db/classes.ts'
import type {
  PullResponse,
  WireClass,
  WireNotebook,
  WireNote,
} from './api.ts'
import { pullRemoteChanges } from './pull.ts'

const remote = (over: Partial<WireNote> = {}): WireNote => ({
  id: '0192f0a1-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
  class_id: null,
  notebook_id: null,
  title: 'Diskrétna matematika',
  body_md: '# Množiny',
  visibility: 'private',
  forked_from_id: null,
  page_order: null,
  version: 3,
  seq: 12,
  created_at: '2026-08-05T09:30:00.000Z',
  updated_at: '2026-08-05T11:02:00.000Z',
  deleted_at: null,
  ...over,
})

const page = (
  notes: WireNote[],
  cursor: number,
  hasMore = false,
): PullResponse => ({
  classes: [],
  notebooks: [],
  notes,
  cursor,
  has_more: hasMore,
})

const remoteClass = (over: Partial<WireClass> = {}): WireClass => ({
  id: '0192f0b1-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
  name: 'Diskrétna matematika',
  code: '1-AIN-101',
  colour: null,
  semester: '2026Z',
  archived_at: null,
  version: 2,
  seq: 10,
  created_at: '2026-08-05T09:30:00.000Z',
  updated_at: '2026-08-05T11:02:00.000Z',
  deleted_at: null,
  ...over,
})

const remoteNotebook = (over: Partial<WireNotebook> = {}): WireNotebook => ({
  id: '0192f0c1-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
  class_id: '0192f0b1-3c4d-7e8f-9a0b-1c2d3e4f5a6b',
  name: 'Prednášky',
  is_general: true,
  kind: 'notes',
  version: 1,
  seq: 11,
  created_at: '2026-08-05T09:30:00.000Z',
  updated_at: '2026-08-05T11:02:00.000Z',
  deleted_at: null,
  ...over,
})

// Records the `since` of every request so paging can be asserted on the wire
// and not only on the rows it left behind.
function serve(pages: PullResponse[]): string[] {
  const asked: string[] = []
  let next = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      asked.push(new URL(url, 'http://localhost').searchParams.get('since')!)
      const body = pages[Math.min(next, pages.length - 1)]!
      next += 1
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
    }),
  )
  return asked
}

const cursor = async (): Promise<number | string | undefined> =>
  (await db.meta.get('syncCursor'))?.value

beforeEach(async () => {
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
  await db.meta.clear()
})

afterEach(() => vi.unstubAllGlobals())

describe('pullRemoteChanges', () => {
  it('inserts a note the client has never seen', async () => {
    const wire = remote()
    serve([page([wire], 12)])

    const summary = await pullRemoteChanges()

    expect(summary).toMatchObject({ applied: 1, skipped: 0, pages: 1 })
    expect(await db.notes.get(wire.id)).toMatchObject({
      title: 'Diskrétna matematika',
      bodyMd: '# Množiny',
      version: 3,
      dirty: false,
      syncedAt: '2026-08-05T11:02:00.000Z',
    })
    // Written by the same path as any other note, so it is searchable.
    expect((await db.notes.get(wire.id))?.searchText).toBe(
      'diskretna matematika # mnoziny',
    )
    expect(await cursor()).toBe(12)
  })

  it('overwrites a clean local note', async () => {
    const local = await createNote({ title: 'stale', bodyMd: 'old body' })
    await db.notes.update(local.id, { dirty: false, version: 1 })
    serve([page([remote({ id: local.id, title: 'server wins' })], 12)])

    const summary = await pullRemoteChanges()

    expect(summary.applied).toBe(1)
    expect(await db.notes.get(local.id)).toMatchObject({
      title: 'server wins',
      bodyMd: '# Množiny',
      version: 3,
      dirty: false,
    })
  })

  it('does not touch a dirty local note', async () => {
    const local = await createNote({ title: 'mine', bodyMd: 'unpushed edits' })
    serve([page([remote({ id: local.id, title: 'server wins' })], 12)])

    const summary = await pullRemoteChanges()

    // Left for the next push, which is the only place a conflict can be
    // detected. Overwriting here loses the edits with no conflict at all.
    expect(summary).toMatchObject({ applied: 0, skipped: 1 })
    expect(await db.notes.get(local.id)).toMatchObject({
      title: 'mine',
      bodyMd: 'unpushed edits',
      version: 0,
      dirty: true,
    })
    // The cursor still advances: the note is dirty, so the next push sends
    // it and the server decides.
    expect(await cursor()).toBe(12)
  })

  it('applies a remote soft delete to a clean note but not a dirty one', async () => {
    const clean = await createNote({ title: 'gone' })
    await db.notes.update(clean.id, { dirty: false, version: 1 })
    const dirty = await createNote({ title: 'still being written' })
    serve([
      page(
        [
          remote({ id: clean.id, deleted_at: '2026-08-06T08:00:00.000Z' }),
          remote({
            id: dirty.id,
            seq: 13,
            deleted_at: '2026-08-06T08:00:00.000Z',
          }),
        ],
        13,
      ),
    ])

    const summary = await pullRemoteChanges()

    expect(summary).toMatchObject({ applied: 1, skipped: 1 })
    expect((await db.notes.get(clean.id))?.deletedAt).toBe(
      '2026-08-06T08:00:00.000Z',
    )
    expect(await db.notes.get(dirty.id)).toMatchObject({
      deletedAt: null,
      title: 'still being written',
      dirty: true,
    })
  })

  it('pages until has_more is false and ends at the last seq', async () => {
    const first = remote({ id: 'note-a', seq: 5 })
    const second = remote({ id: 'note-b', seq: 9 })
    const asked = serve([page([first], 5, true), page([second], 9)])

    const summary = await pullRemoteChanges()

    expect(summary).toMatchObject({ applied: 2, pages: 2 })
    // The second request resumes from the first page's cursor rather than
    // asking for the whole history again.
    expect(asked).toEqual(['0', '5'])
    expect(await db.notes.get('note-a')).toBeDefined()
    expect(await db.notes.get('note-b')).toBeDefined()
    expect(await cursor()).toBe(9)
  })

  it('leaves the cursor where it was when applying a page throws', async () => {
    await db.meta.put({ key: 'syncCursor', value: 4 })
    serve([page([remote({ id: 'note-a' }), remote({ id: 'note-b' })], 12)])
    // The second row fails, so the page is applied by halves and only the
    // transaction can save it.
    const stored = db.notes.put.bind(db.notes)
    let writes = 0
    vi.spyOn(db.notes, 'put').mockImplementation(((note: Note) => {
      writes += 1
      if (writes === 2) return Promise.reject(new Error('QuotaExceededError'))
      return stored(note)
    }) as typeof db.notes.put)

    await expect(pullRemoteChanges()).rejects.toThrow('QuotaExceededError')

    // Both must be true. A cursor past notes that were never stored means
    // nothing ever asks for them again, and nothing reports it.
    expect(await cursor()).toBe(4)
    expect(await db.notes.get('note-a')).toBeUndefined()

    vi.restoreAllMocks()
  })
})


describe('pulling classes and notebooks', () => {
  it('applies all three kinds from one page and stores the cursor once', async () => {
    serve([
      {
        classes: [remoteClass()],
        notebooks: [remoteNotebook()],
        notes: [remote({ seq: 12 })],
        cursor: 12,
        has_more: false,
      },
    ])

    const summary = await pullRemoteChanges()

    expect(summary.applied).toBe(3)
    expect(await db.classes.count()).toBe(1)
    expect(await db.notebooks.count()).toBe(1)
    expect(await db.notes.count()).toBe(1)

    const stored = await db.classes.get(remoteClass().id)
    expect(stored).toMatchObject({
      name: 'Diskrétna matematika',
      code: '1-AIN-101',
      semester: '2026Z',
      archivedAt: null,
      version: 2,
      dirty: false,
      syncedAt: '2026-08-05T11:02:00.000Z',
    })
    expect((await db.notebooks.toArray())[0]).toMatchObject({
      classId: remoteClass().id,
      isGeneral: true,
      dirty: false,
    })
    // One cursor for the page, written after all three arrays.
    expect((await db.meta.get('syncCursor'))?.value).toBe(12)
  })

  it('carries an archived class and a deleted notebook', async () => {
    serve([
      {
        classes: [remoteClass({ archived_at: '2026-08-05T11:00:00.000Z' })],
        notebooks: [remoteNotebook({ deleted_at: '2026-08-05T11:00:00.000Z' })],
        notes: [],
        cursor: 12,
        has_more: false,
      },
    ])

    await pullRemoteChanges()

    expect((await db.classes.toArray())[0]?.archivedAt).toBe(
      '2026-08-05T11:00:00.000Z',
    )
    // A soft delete reaching this device is the whole reason deleted rows
    // travel; the row stays, hidden by the read helpers.
    expect((await db.notebooks.toArray())[0]?.deletedAt).toBe(
      '2026-08-05T11:00:00.000Z',
    )
  })

  it('leaves a dirty class alone rather than overwriting it', async () => {
    const created = await createClass({ name: 'Renamed here, not yet pushed' })

    serve([
      {
        classes: [remoteClass({ id: created.id, name: 'The server copy' })],
        notebooks: [],
        notes: [],
        cursor: 12,
        has_more: false,
      },
    ])

    const summary = await pullRemoteChanges()

    // The one row a pull must never write over: it holds an edit the server
    // has not seen, and the next push is what resolves it.
    expect((await db.classes.get(created.id))?.name).toBe(
      'Renamed here, not yet pushed',
    )
    expect(summary.applied).toBe(0)
    expect(summary.skipped).toBe(1)
  })
})
