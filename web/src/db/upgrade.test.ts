import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { declareSchema, type Note } from './schema.ts'

// The v1 store declaration, copied rather than imported. An applied
// migration is frozen; a test that followed a later edit to it would stop
// testing the upgrade that actually shipped to devices.
const V1_STORES = 'id, updatedAt, deletedAt, dirty, classId'
const V2_STORES = 'id, updatedAt, deletedAt, dirty, classId, searchText'

// Not `nefix`: these have to open a database at an old version, which the
// application's own instance can never be again.
const NAME = 'nefix-upgrade-test'
const V2_NAME = 'nefix-upgrade-test-v2'

const v1Note = (
  id: string,
  title: string,
  bodyMd: string,
  deletedAt: string | null = null,
): Omit<Note, 'searchText'> => ({
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
    expect(after.verno).toBe(3)
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

    expect(after.verno).toBe(3)
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
