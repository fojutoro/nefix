import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNote } from '../db/notes.ts'
import { db, type Note } from '../db/schema.ts'
import i18n from '../i18n/index.ts'
import { createClass } from '../db/classes.ts'
import type {
  PushClass,
  PushNote,
  PushNotebook,
  PushResult,
  WireClass,
  WireNotebook,
  WireNote,
} from './api.ts'
import { pushDirtyRows } from './push.ts'
import { syncState } from './state.ts'

const wire = (note: Note, over: Partial<WireNote> = {}): WireNote => ({
  id: note.id,
  class_id: note.classId,
  notebook_id: note.notebookId,
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
    kind: 'note' as const,
    status: 'accepted' as const,
    note: { ...note, version: note.version + 1, seq: 7, created_at: 'c', updated_at: '2026-08-05T12:00:00.000Z' },
  }))

// A signed-in browser holds the readable half of the pair, and every
// non-GET request refuses to leave without it.
const CSRF_FIXTURE = 'nefix_csrf=Zm9yLXRlc3Rz'

beforeEach(async () => {
  document.cookie = CSRF_FIXTURE
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
  await i18n.changeLanguage('en')
  syncState.setState({
    status: 'idle',
    lastSummary: null,
    lastSyncedAt: null,
    lastError: null,
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('pushDirtyRows', () => {
  it('sends only the dirty notes', async () => {
    const dirty = await createNote({ title: 'dirty' })
    const clean = await createNote({ title: 'clean' })
    await db.notes.update(clean.id, { dirty: false })

    const batches = serve(accept)
    await pushDirtyRows()

    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((note) => note.id)).toEqual([dirty.id])
  })

  it('clears dirty and stores the returned version on accepted', async () => {
    const note = await createNote({ title: 'algebra' })
    serve((sent) => [
      {
        id: sent[0]!.id,
        kind: 'note',
        status: 'accepted',
        note: wire(note, { version: 4 }),
      },
    ])

    const summary = await pushDirtyRows()

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
        kind: 'note',
        status: 'conflict',
        note: wire(note, {
          title: 'theirs',
          body_md: 'server body',
          version: 9,
        }),
      },
    ])

    const summary = await pushDirtyRows()

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
      return [
        {
          id: sent[0]!.id,
          kind: 'note' as const,
          status: 'accepted' as const,
          note: wire(note, { version: 3 }),
        },
      ]
    })

    await pushDirtyRows()

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
        notebookId: null,
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
    await pushDirtyRows()

    expect(batches.map((batch) => batch.length)).toEqual([100, 1])
  })

  it('leaves every note dirty and reports offline when the network fails', async () => {
    await createNote({ title: 'algebra' })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )

    const summary = await pushDirtyRows()

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

    const summary = await pushDirtyRows()

    expect(summary.failed).toBe(1)
    expect((await db.notes.toArray()).every((note) => note.dirty)).toBe(true)
    expect(syncState.current.status).toBe('unauthenticated')
  })

  it('sends one set of requests when two runs overlap', async () => {
    await createNote({ title: 'algebra' })
    const batches = serve(accept)

    await Promise.all([pushDirtyRows(), pushDirtyRows()])

    expect(batches).toHaveLength(1)
  })

  it('releases the guard when a subscriber throws on the first notification', async () => {
    const note = await createNote({ title: 'algebra' })
    const batches = serve(accept)

    // The status is published before a single note is sent, so a subscriber
    // throwing there is the earliest thing that can go wrong. Whether the run
    // rejects or swallows it is not the point: the guard has to come back, or
    // the queue never drains again and nothing ever says why.
    let poisoned = true
    const unsubscribe = syncState.subscribe(() => {
      if (poisoned) {
        poisoned = false
        throw new Error('a subscriber blew up')
      }
    })
    await pushDirtyRows().catch(() => undefined)
    unsubscribe()

    batches.length = 0
    await pushDirtyRows()

    // A request, not a resolved promise: a stranded guard returns the empty
    // summary quite happily and sends nothing.
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((sent) => sent.id)).toEqual([note.id])
  })
})

describe('the CSRF guard', () => {
  it('refuses to send a write when the cookie cannot be read', async () => {
    // What a browser that has never signed in looks like, or one whose
    // readable cookie expired under it.
    document.cookie = 'nefix_csrf=; max-age=0'
    const calls = serve(accept)
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# Množiny' })

    const summary = await pushDirtyRows()

    // Nothing went out. A request sent without the header comes back 403 and
    // reads like a server fault instead of a missing cookie.
    expect(calls).toHaveLength(0)
    expect(summary.failed).toBe(1)
    expect(syncState.current.status).toBe('error')
    // Still dirty, so the note is sent once signing in restores the cookie.
    expect(await db.notes.filter((note) => note.dirty).count()).toBe(1)
  })
})


type PushBody = {
  classes: PushClass[]
  notebooks: PushNotebook[]
  notes: PushNote[]
}

// The whole request rather than one array of it, so the three can be
// asserted against each other.
function serveRows(handler: (body: PushBody) => PushResult[]): PushBody[] {
  const sent: PushBody[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as PushBody
      sent.push(body)
      return { ok: true, status: 200, json: async () => ({ results: handler(body) }) }
    }),
  )
  return sent
}

const acceptedClass = (row: PushClass): PushResult => ({
  id: row.id,
  kind: 'class',
  status: 'accepted',
  class: { ...row, version: row.version + 1, seq: 1, created_at: 'c', updated_at: 'u' },
})

const acceptedNotebook = (row: PushNotebook): PushResult => ({
  id: row.id,
  kind: 'notebook',
  status: 'accepted',
  notebook: { ...row, version: row.version + 1, seq: 2, created_at: 'c', updated_at: 'u' },
})

const acceptedNote = (row: PushNote): PushResult => ({
  id: row.id,
  kind: 'note',
  status: 'accepted',
  note: { ...row, version: row.version + 1, seq: 3, created_at: 'c', updated_at: 'u' },
})

const acceptEverything = (body: PushBody): PushResult[] => [
  ...body.classes.map(acceptedClass),
  ...body.notebooks.map(acceptedNotebook),
  ...body.notes.map(acceptedNote),
]

describe('pushing classes and notebooks', () => {
  it('sends all three kinds in one request and clears every dirty flag', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    const notebook = (await db.notebooks.toArray())[0]!
    await createNote({ title: 'Množiny', notebookId: notebook.id })

    const sent = serveRows(acceptEverything)
    const summary = await pushDirtyRows()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.classes.map((row) => row.id)).toEqual([created.id])
    expect(sent[0]!.notebooks.map((row) => row.id)).toEqual([notebook.id])
    expect(sent[0]!.notes).toHaveLength(1)
    // The general notebook rides with its class, so the server never briefly
    // holds a notebook whose class it has not seen.
    expect(sent[0]!.notebooks[0]!.class_id).toBe(created.id)
    expect(sent[0]!.notebooks[0]!.is_general).toBe(true)

    expect(summary.pushed).toBe(3)
    expect((await db.classes.get(created.id))?.dirty).toBe(false)
    expect((await db.classes.get(created.id))?.version).toBe(1)
    expect((await db.notebooks.get(notebook.id))?.dirty).toBe(false)
    expect((await db.notes.toArray())[0]!.dirty).toBe(false)
  })

  it('takes the server copy of a conflicted notebook without forking', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    const local = (await db.notebooks.toArray())[0]!
    await db.notebooks.update(local.id, { name: 'Renamed on this device' })

    serveRows((body) => [
      ...body.classes.map(acceptedClass),
      {
        id: local.id,
        kind: 'notebook',
        status: 'conflict',
        notebook: {
          id: local.id,
          class_id: created.id,
          name: 'Renamed on the other device',
          is_general: true,
          version: 5,
          seq: 9,
          created_at: local.createdAt,
          updated_at: '2026-08-05T12:00:00.000Z',
          deleted_at: null,
        } satisfies WireNotebook,
      },
    ])

    const summary = await pushDirtyRows()

    // Last write wins, deliberately unlike a note: one row, not two.
    const rows = await db.notebooks.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: local.id,
      name: 'Renamed on the other device',
      version: 5,
      dirty: false,
      syncedAt: '2026-08-05T12:00:00.000Z',
    })
    expect(summary.conflicted).toBe(1)
  })

  it('takes the server copy of a conflicted class without forking', async () => {
    const created = await createClass({ name: 'Renamed on this device' })

    serveRows((body) => [
      {
        id: created.id,
        kind: 'class',
        status: 'conflict',
        class: {
          id: created.id,
          name: 'Renamed on the other device',
          code: null,
          colour: null,
          semester: null,
          archived_at: null,
          version: 4,
          seq: 8,
          created_at: created.createdAt,
          updated_at: '2026-08-05T12:00:00.000Z',
          deleted_at: null,
        } satisfies WireClass,
      },
      ...body.notebooks.map(acceptedNotebook),
    ])

    await pushDirtyRows()

    const rows = await db.classes.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'Renamed on the other device',
      version: 4,
      dirty: false,
    })
  })

  it('still forks a conflicted note, which classes and notebooks do not', async () => {
    const note = await createNote({ title: 'Množiny' })

    serveRows((body) => [
      {
        id: note.id,
        kind: 'note',
        status: 'conflict',
        note: wire(note, { title: 'the server copy', version: 9 }),
      },
      ...body.classes.map(acceptedClass),
    ])

    await pushDirtyRows()

    // The two rules sit side by side on purpose. A note holds writing that
    // only exists on this device; a notebook name does not.
    expect(await db.notes.count()).toBe(2)
    expect(await db.classes.count()).toBe(0)
  })

  it('splits each array at a hundred independently', async () => {
    const now = new Date().toISOString()
    await db.notebooks.bulkAdd(
      Array.from({ length: 101 }, (_, index) => ({
        id: `0192f0c1-3c4d-7e8f-9a0b-${String(index).padStart(12, '0')}`,
        classId: null,
        name: `notebook ${index}`,
        isGeneral: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 0,
        dirty: true,
        syncedAt: null,
      })),
    )
    await createNote({ title: 'Množiny' })

    const sent = serveRows(acceptEverything)
    await pushDirtyRows()

    expect(sent.map((body) => body.notebooks.length)).toEqual([100, 1])
    // The note travels with the first request rather than waiting for the
    // notebooks to drain.
    expect(sent.map((body) => body.notes.length)).toEqual([1, 0])
  })
})
