import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { declareSchema, type Note, type Notebook } from './schema.ts'

// The v1 store declaration, copied rather than imported. An applied
// migration is frozen; a test that followed a later edit to it would stop
// testing the upgrade that actually shipped to devices.
const V1_STORES = 'id, updatedAt, deletedAt, dirty, classId'
const V2_STORES = 'id, updatedAt, deletedAt, dirty, classId, searchText'

// Not `nefix`: these have to open a database at an old version, which the
// application's own instance can never be again.
const NAME = 'nefix-upgrade-test'
const V2_NAME = 'nefix-upgrade-test-v2'
const V3_NAME = 'nefix-upgrade-test-v3'

const v1Note = (
  id: string,
  title: string,
  bodyMd: string,
  deletedAt: string | null = null,
): Omit<Note, 'searchText' | 'notebookId' | 'pageOrder'> => ({
  id,
  classId: null,
  title,
  bodyMd,
  visibility: 'private',
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
  deletedAt,
  forkedFromId: null,
  version: 0,
  dirty: true,
  syncedAt: null,
})

describe('the v1 upgrade', () => {
  it('backfills searchText and keeps what the rows already held', async () => {
    const before = new Dexie(NAME)
    before.version(1).stores({ notes: V1_STORES })
    await before.open()
    await before.table('notes').bulkAdd([
      v1Note('a', 'Diskrétna matematika', '# Množiny\n\nrelácie a funkcie'),
      v1Note('b', 'linearna algebra', 'vektory'),
      v1Note('c', 'Zmazaná', 'text', '2026-07-02T10:00:00.000Z'),
    ])
    expect(before.verno).toBe(1)
    before.close()

    const after = new Dexie(NAME)
    declareSchema(after)
    await after.open()

    // Every version since is applied at once, which is what a device that
    // skipped a release actually does.
    expect(after.verno).toBe(5)
    const rows = after.table<Note>('notes')

    const upgraded = await rows.get('a')
    // The content survives the upgrade untouched.
    expect(upgraded?.title).toBe('Diskrétna matematika')
    expect(upgraded?.bodyMd).toBe('# Množiny\n\nrelácie a funkcie')
    expect(upgraded?.createdAt).toBe('2026-07-01T10:00:00.000Z')
    expect(upgraded?.searchText).toBe(
      'diskretna matematika # mnoziny relacie a funkcie',
    )

    expect((await rows.get('b'))?.searchText).toBe(
      'linearna algebra vektory',
    )
    // A deleted row is backfilled too, because a restore puts it back
    // without touching its title or body.
    expect((await rows.get('c'))?.searchText).toBe('zmazana text')

    // The new index is usable, which is the point of the version bump.
    expect(await rows.where('searchText').startsWith('diskretna').count()).toBe(
      1,
    )

    after.close()
  })
})

describe('the v2 to v3 upgrade', () => {
  it('adds the meta store and keeps every note', async () => {
    const before = new Dexie(V2_NAME)
    before.version(1).stores({ notes: V1_STORES })
    before.version(2).stores({ notes: V2_STORES })
    await before.open()
    await before.table('notes').bulkAdd([
      { ...v1Note('a', 'Diskrétna matematika', '# Množiny'),
        searchText: 'diskretna matematika # mnoziny' },
      { ...v1Note('b', 'linearna algebra', 'vektory', '2026-07-02T10:00:00.000Z'),
        searchText: 'linearna algebra vektory' },
    ])
    expect(before.verno).toBe(2)
    before.close()

    const after = new Dexie(V2_NAME)
    declareSchema(after)
    await after.open()

    expect(after.verno).toBe(5)
    const rows = after.table<Note>('notes')
    expect(await rows.count()).toBe(2)
    // The notes survive untouched: v3 declares only the new store, so the
    // notes table is not rewritten at all.
    expect(await rows.get('a')).toMatchObject({
      title: 'Diskrétna matematika',
      bodyMd: '# Množiny',
      searchText: 'diskretna matematika # mnoziny',
      dirty: true,
    })
    expect((await rows.get('b'))?.deletedAt).toBe('2026-07-02T10:00:00.000Z')

    // Empty, not absent: a device that has never pulled reads no cursor row
    // and sends since=0, which is a fresh device asking for everything.
    const meta = after.table<{ key: string; value: number }>('meta')
    expect(await meta.get('syncCursor')).toBeUndefined()
    await meta.put({ key: 'syncCursor', value: 42 })
    expect((await meta.get('syncCursor'))?.value).toBe(42)

    after.close()
  })
})

describe('the v3 to v4 upgrade', () => {
  it('files every existing note as unfiled and keeps its body', async () => {
    const before = new Dexie(V3_NAME)
    before.version(1).stores({ notes: V1_STORES })
    before.version(2).stores({ notes: V2_STORES })
    before.version(3).stores({ meta: 'key' })
    await before.open()
    await before.table('notes').bulkAdd([
      {
        ...v1Note('a', 'Diskrétna matematika', '# Množiny\n\nrelácie'),
        searchText: 'diskretna matematika # mnoziny relacie',
      },
      {
        ...v1Note('b', 'Zmazaná', 'text', '2026-07-02T10:00:00.000Z'),
        searchText: 'zmazana text',
      },
    ])
    await before.table('meta').put({ key: 'syncCursor', value: 42 })
    expect(before.verno).toBe(3)
    before.close()

    const after = new Dexie(V3_NAME)
    declareSchema(after)
    await after.open()

    expect(after.verno).toBe(5)
    const rows = after.table<Note>('notes')
    expect(await rows.count()).toBe(2)

    const upgraded = await rows.get('a')
    // Unfiled, which is correct and needs no guessing: there is no notebook
    // on this device that a note written before notebooks existed belongs to.
    expect(upgraded?.notebookId).toBeNull()
    expect(upgraded?.title).toBe('Diskrétna matematika')
    expect(upgraded?.bodyMd).toBe('# Množiny\n\nrelácie')
    expect(upgraded?.searchText).toBe('diskretna matematika # mnoziny relacie')
    expect(upgraded?.createdAt).toBe('2026-07-01T10:00:00.000Z')
    expect(upgraded?.dirty).toBe(true)

    // A deleted note is backfilled too: a restore brings it back and it
    // would otherwise come back with notebookId undefined.
    const deleted = await rows.get('b')
    expect(deleted?.notebookId).toBeNull()
    expect(deleted?.deletedAt).toBe('2026-07-02T10:00:00.000Z')

    // The cursor survives. Losing it would make the next pull re-download
    // the whole history and overwrite these rows with the server's copies.
    const meta = after.table<{ key: string; value: number }>('meta')
    expect((await meta.get('syncCursor'))?.value).toBe(42)

    // The new stores are empty and usable, not absent.
    expect(await after.table('classes').count()).toBe(0)
    expect(await after.table('notebooks').count()).toBe(0)

    after.close()
  })
})

// The v4 store declarations, copied for the reason V1_STORES is: an applied
// migration is frozen, and a test that followed a later edit to declareSchema
// would stop testing the upgrade that shipped.
const V4_CLASSES = 'id, name, archivedAt, updatedAt, deletedAt'
const V4_NOTEBOOKS = 'id, classId, name, updatedAt, deletedAt'
const V4_NOTES =
  'id, updatedAt, deletedAt, dirty, classId, searchText, notebookId'

const V4_NAME = 'nefix-upgrade-test-v4'

describe('the v4 to v5 upgrade', () => {
  it('marks every notebook as notes and leaves every note unpaged', async () => {
    const before = new Dexie(V4_NAME)
    before.version(1).stores({ notes: V1_STORES })
    before.version(2).stores({ notes: V2_STORES })
    before.version(3).stores({ meta: 'key' })
    before.version(4).stores({
      classes: V4_CLASSES,
      notebooks: V4_NOTEBOOKS,
      notes: V4_NOTES,
    })
    await before.open()

    // A seeded database rather than an empty one: a class, its general
    // notebook, a second notebook, two notes in them and one deleted.
    await before.table('classes').add({
      id: 'c1',
      name: 'Diskrétna matematika',
      code: '1-AIN-101',
      colour: '#3355ff',
      semester: '2026Z',
      archivedAt: null,
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-01T10:00:00.000Z',
      deletedAt: null,
      version: 3,
      dirty: false,
      syncedAt: '2026-07-01T10:00:00.000Z',
    })
    await before.table('notebooks').bulkAdd([
      {
        id: 'n1',
        classId: 'c1',
        name: 'Všeobecné',
        isGeneral: true,
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:00:00.000Z',
        deletedAt: null,
        version: 1,
        dirty: false,
        syncedAt: '2026-07-01T10:00:00.000Z',
      },
      {
        id: 'n2',
        classId: 'c1',
        name: 'Cvičenia',
        isGeneral: false,
        createdAt: '2026-07-02T10:00:00.000Z',
        updatedAt: '2026-07-02T10:00:00.000Z',
        deletedAt: '2026-07-03T10:00:00.000Z',
        version: 2,
        dirty: true,
        syncedAt: null,
      },
    ])
    await before.table('notes').bulkAdd([
      {
        ...v1Note('a', 'Množiny', '# Množiny\n\nrelácie'),
        searchText: 'mnoziny # mnoziny relacie',
        notebookId: 'n1',
      },
      {
        ...v1Note('b', 'Zmazaná', 'text', '2026-07-02T10:00:00.000Z'),
        searchText: 'zmazana text',
        notebookId: 'n2',
      },
    ])
    await before.table('meta').put({ key: 'syncCursor', value: 42 })
    expect(before.verno).toBe(4)
    before.close()

    const after = new Dexie(V4_NAME)
    declareSchema(after)
    await after.open()

    expect(after.verno).toBe(5)

    // Every existing notebook is a notebook of notes. A device that upgrades
    // has no collegebooks, because there was no way to make one.
    const notebooks = after.table<Notebook>('notebooks')
    expect(await notebooks.count()).toBe(2)
    expect(await notebooks.get('n1')).toMatchObject({
      kind: 'notes',
      name: 'Všeobecné',
      isGeneral: true,
      classId: 'c1',
      version: 1,
    })
    // The deleted one too: a restore brings it back, and it would otherwise
    // come back with an undefined kind, which no filter matches.
    expect(await notebooks.get('n2')).toMatchObject({
      kind: 'notes',
      deletedAt: '2026-07-03T10:00:00.000Z',
      dirty: true,
    })

    // null rather than undefined, for the reason v4 backfilled notebookId:
    // undefined is a value no query matches, and listPages filters on it.
    const notes = after.table<Note>('notes')
    expect(await notes.count()).toBe(2)
    const kept = await notes.get('a')
    expect(kept?.pageOrder).toBeNull()
    expect(kept?.title).toBe('Množiny')
    expect(kept?.bodyMd).toBe('# Množiny\n\nrelácie')
    expect(kept?.notebookId).toBe('n1')
    expect(kept?.searchText).toBe('mnoziny # mnoziny relacie')
    expect(kept?.createdAt).toBe('2026-07-01T10:00:00.000Z')

    const deleted = await notes.get('b')
    expect(deleted?.pageOrder).toBeNull()
    expect(deleted?.deletedAt).toBe('2026-07-02T10:00:00.000Z')

    // The class is untouched, and the cursor survives: losing it would make
    // the next pull re-download everything and overwrite these rows.
    expect(await after.table('classes').get('c1')).toMatchObject({
      name: 'Diskrétna matematika',
      code: '1-AIN-101',
      version: 3,
    })
    const meta = after.table<{ key: string; value: number }>('meta')
    expect((await meta.get('syncCursor'))?.value).toBe(42)

    after.close()
  })
})
