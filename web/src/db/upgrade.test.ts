import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { declareSchema, type Note } from './schema.ts'

// The v1 store declaration, copied rather than imported. An applied
// migration is frozen; a test that followed a later edit to it would stop
// testing the upgrade that actually shipped to devices.
const V1_STORES = 'id, updatedAt, deletedAt, dirty, classId'

// Not `nefix`: this has to open a database at v1, which the application's
// own instance can never be again.
const NAME = 'nefix-upgrade-test'

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

describe('the v1 to v2 upgrade', () => {
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

    expect(after.verno).toBe(2)
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
