import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNote } from '../db/notes.ts'
import { db, type Note } from '../db/schema.ts'
import i18n from '../i18n/index.ts'
import type { PushNote, PushResult, WireNote } from './api.ts'
import { pushDirtyNotes } from './push.ts'
import { syncState } from './state.ts'

const wire = (note: Note, over: Partial<WireNote> = {}): WireNote => ({
  id: note.id,
  class_id: note.classId,
  title: note.title,
  body_md: note.bodyMd,
  visibility: note.visibility,
  forked_from_id: note.forkedFromId,
  version: note.version + 1,
  seq: 7,
  created_at: note.createdAt,
  updated_at: '2026-08-05T12:00:00.000Z',
  deleted_at: note.deletedAt,
  ...over,
})

type Handler = (sent: PushNote[]) => Promise<PushResult[]> | PushResult[]

// Only .ok, .status and .json() are read, so a real Response is not needed and
// the fake keeps the test off the platform's fetch entirely.
function serve(handler: Handler): PushNote[][] {
  const batches: PushNote[][] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const sent = (JSON.parse(init.body) as { notes: PushNote[] }).notes
      batches.push(sent)
      const results = await handler(sent)
      return { ok: true, status: 200, json: async () => ({ results }) }
    }),
  )
  return batches
}

const accept = (sent: PushNote[]): PushResult[] =>
  sent.map((note) => ({
    id: note.id,
    status: 'accepted' as const,
    note: { ...note, version: note.version + 1, seq: 7, created_at: 'c', updated_at: '2026-08-05T12:00:00.000Z' },
  }))

beforeEach(async () => {
  await db.notes.clear()
  await i18n.changeLanguage('en')
  syncState.setState({
    status: 'idle',
    lastSummary: null,
    lastSyncedAt: null,
    lastError: null,
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('pushDirtyNotes', () => {
  it('sends only the dirty notes', async () => {
    const dirty = await createNote({ title: 'dirty' })
    const clean = await createNote({ title: 'clean' })
    await db.notes.update(clean.id, { dirty: false })

    const batches = serve(accept)
    await pushDirtyNotes()

    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((note) => note.id)).toEqual([dirty.id])
  })

  it('clears dirty and stores the returned version on accepted', async () => {
    const note = await createNote({ title: 'algebra' })
    serve((sent) => [
      { id: sent[0]!.id, status: 'accepted', note: wire(note, { version: 4 }) },
    ])

    const summary = await pushDirtyNotes()

    expect(summary).toMatchObject({ pushed: 1, conflicted: 0, failed: 0 })
    expect(await db.notes.get(note.id)).toMatchObject({
      dirty: false,
      version: 4,
      syncedAt: '2026-08-05T12:00:00.000Z',
    })
    expect(syncState.current.status).toBe('idle')
  })

  it('keeps both versions on conflict', async () => {
    const note = await createNote({ title: 'algebra', bodyMd: 'mine' })
    serve((sent) => [
      {
        id: sent[0]!.id,
        status: 'conflict',
        note: wire(note, { title: 'theirs', body_md: 'server body', version: 9 }),
      },
    ])

    const summary = await pushDirtyNotes()

    expect(summary).toMatchObject({ pushed: 0, conflicted: 1 })
    // The server's copy takes the original id, clean and at the server's
    // version, so the next push does not re-conflict.
    expect(await db.notes.get(note.id)).toMatchObject({
      title: 'theirs',
      bodyMd: 'server body',
      version: 9,
      dirty: false,
      syncedAt: '2026-08-05T12:00:00.000Z',
    })
    // The local copy survives beside it under a new id, still dirty, so it
    // syncs as a new note rather than being overwritten again.
    const rows = await db.notes.toArray()
    expect(rows).toHaveLength(2)
    const copy = rows.find((row) => row.id !== note.id)!
    expect(copy).toMatchObject({
      title: 'algebra (older version)',
      bodyMd: 'mine',
      version: 0,
      dirty: true,
      syncedAt: null,
    })
    expect(copy.searchText).toContain('older version')
  })

  it('leaves a note edited during the request dirty', async () => {
    const note = await createNote({ title: 'algebra', bodyMd: 'first' })
    // Written between the response arriving and the result being applied. The
    // timestamp is explicit because two writes in one millisecond produce the
    // same updatedAt string, and then the guard has nothing to compare.
    serve(async (sent) => {
      await db.notes.update(sent[0]!.id, {
        bodyMd: 'typed while syncing',
        updatedAt: '2099-01-01T00:00:00.000Z',
      })
      return [{ id: sent[0]!.id, status: 'accepted', note: wire(note, { version: 3 }) }]
    })

    await pushDirtyNotes()

    expect(await db.notes.get(note.id)).toMatchObject({
      bodyMd: 'typed while syncing',
      dirty: true,
      // Still recorded: the server does hold version 3, and sending the old
      // one next time would conflict the user against their own write.
      version: 3,
    })
  })

  it('splits more than a hundred notes across requests', async () => {
    const now = new Date().toISOString()
    await db.notes.bulkAdd(
      Array.from({ length: 101 }, (_, index) => ({
        id: `0192f0a1-3c4d-7e8f-9a0b-${String(index).padStart(12, '0')}`,
        classId: null,
        title: `note ${index}`,
        bodyMd: '',
        searchText: `note ${index}`,
        visibility: 'private' as const,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        forkedFromId: null,
        version: 0,
        dirty: true,
        syncedAt: null,
      })),
    )

    const batches = serve(accept)
    await pushDirtyNotes()

    expect(batches.map((batch) => batch.length)).toEqual([100, 1])
  })

  it('leaves every note dirty and reports offline when the network fails', async () => {
    await createNote({ title: 'algebra' })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    const summary = await pushDirtyNotes()

    expect(summary.failed).toBe(1)
    expect((await db.notes.toArray()).every((note) => note.dirty)).toBe(true)
    expect(syncState.current.status).toBe('offline')
  })

  it('leaves every note dirty and reports unauthenticated on a 401', async () => {
    await createNote({ title: 'algebra' })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ error: 'authentication required' }),
        }),
      ),
    )

    const summary = await pushDirtyNotes()

    expect(summary.failed).toBe(1)
    expect((await db.notes.toArray()).every((note) => note.dirty)).toBe(true)
    expect(syncState.current.status).toBe('unauthenticated')
  })

  it('sends one set of requests when two runs overlap', async () => {
    await createNote({ title: 'algebra' })
    const batches = serve(accept)

    await Promise.all([pushDirtyNotes(), pushDirtyNotes()])

    expect(batches).toHaveLength(1)
  })
})
