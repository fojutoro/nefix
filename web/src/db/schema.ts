import Dexie, { type EntityTable } from 'dexie'
import { normalize } from './normalize.ts'

export type Note = {
  // UUIDv7, minted on the client so a note can be created offline. The
  // server's notes.id will therefore be TEXT, not an integer, in phase 4.
  id: string
  classId: string | null
  title: string
  bodyMd: string
  // `faculty` is readable by its author alone until users have a faculty,
  // but the server already returns it, so the union has to admit it.
  visibility: 'private' | 'faculty' | 'public'
  // ISO 8601 UTC. One representation everywhere, and it sorts lexically.
  createdAt: string
  updatedAt: string
  // Soft delete. A hard delete would leave sync unable to tell "deleted"
  // from "never existed", so the note would return on the next pull.
  deletedAt: string | null
  forkedFromId: string | null

  // Title and body, normalised, maintained by every mutation that changes
  // either. Normalising at query time would mean normalising every note on
  // every keystroke, which degrades as notes accumulate.
  searchText: string

  // Sync metadata. Meaningless until phase 4, present from the start so
  // that phase does not have to migrate every note already on a device.
  version: number
  dirty: boolean
  syncedAt: string | null
}

// A key/value row. The sync cursor lives here and not in localStorage: it
// describes the notes in this database, so clearing one without the other
// would leave the client believing it holds notes it does not have.
export type Meta = {
  key: string
  value: number | string
}

export const searchTextOf = (title: string, bodyMd: string): string =>
  normalize(`${title} ${bodyMd}`)

// Taking the database means the upgrade path can be opened under another
// name and tested, rather than only ever running against whatever is
// already on the developer's machine.
export function declareSchema(db: Dexie): void {
  // IndexedDB accepts only numbers, strings, dates, binaries and arrays as
  // keys. `dirty` is a boolean and an undeleted `deletedAt` is null, so
  // neither value enters its index: the dirty index stays empty and the
  // deletedAt index holds deleted rows only. Both are declared now because
  // adding an index later is a version bump, and reads filter in memory.
  db.version(1).stores({
    notes: 'id, updatedAt, deletedAt, dirty, classId',
  })

  db.version(2)
    .stores({ notes: 'id, updatedAt, deletedAt, dirty, classId, searchText' })
    .upgrade((tx) =>
      // Deleted rows are backfilled too. A restore puts a row back without
      // touching its title or body, so one skipped here would return
      // invisible to search.
      tx
        .table<Note>('notes')
        .toCollection()
        .modify((note) => {
          note.searchText = searchTextOf(note.title, note.bodyMd)
        }),
    )

  // Only the new store is declared. Dexie treats a version's stores as a
  // delta, so `notes` keeps the schema and the rows v2 left it with, and no
  // upgrade function is needed: a missing cursor row reads as 0, which is
  // what a device that has never pulled should send.
  db.version(3).stores({ meta: 'key' })
}

export const db = new Dexie('nefix') as Dexie & {
  notes: EntityTable<Note, 'id'>
  meta: EntityTable<Meta, 'key'>
}

declareSchema(db)
