import Dexie, { type EntityTable } from 'dexie'

export type Note = {
  // UUIDv7, minted on the client so a note can be created offline. The
  // server's notes.id will therefore be TEXT, not an integer, in phase 4.
  id: string
  classId: string | null
  title: string
  bodyMd: string
  visibility: 'private' | 'public'
  // ISO 8601 UTC. One representation everywhere, and it sorts lexically.
  createdAt: string
  updatedAt: string
  // Soft delete. A hard delete would leave sync unable to tell "deleted"
  // from "never existed", so the note would return on the next pull.
  deletedAt: string | null
  forkedFromId: string | null

  // Sync metadata. Meaningless until phase 4, present from the start so
  // that phase does not have to migrate every note already on a device.
  version: number
  dirty: boolean
  syncedAt: string | null
}

export const db = new Dexie('nefix') as Dexie & {
  notes: EntityTable<Note, 'id'>
}

// IndexedDB accepts only numbers, strings, dates, binaries and arrays as
// keys. `dirty` is a boolean and an undeleted `deletedAt` is null, so
// neither value enters its index: the dirty index stays empty and the
// deletedAt index holds deleted rows only. Both are declared now because
// adding an index later is a version bump, and reads filter in memory.
db.version(1).stores({
  notes: 'id, updatedAt, deletedAt, dirty, classId',
})
