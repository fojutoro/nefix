import Dexie, { type EntityTable } from 'dexie'
import { normalize } from './normalize.ts'

export type Note = {
  // UUIDv7, minted on the client so a note can be created offline. The
  // server's notes.id will therefore be TEXT, not an integer, in phase 4.
  id: string
  // Vestigial and must stay null. The server still decodes this field as an
  // integer, so a non-null value is a 400, and the column is dropped a
  // release from now. Membership is notebookId.
  classId: string | null
  // Null is an unfiled note, which is a real case: taking a note must never
  // require setting up a class first.
  notebookId: string | null
  title: string
  bodyMd: string
  // `faculty` is readable by its author alone until users have a faculty,
  // but the server already returns it, so the union has to admit it.
  visibility: 'private' | 'faculty' | 'public'
  // The note's position in its collegebook, and null for a note that is not
  // a page. A float, so a page inserted between two others is the midpoint of
  // their orders and nothing after it is renumbered.
  pageOrder: number | null
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

export type Class = {
  id: string
  name: string
  code: string | null
  colour: string | null
  semester: string | null
  // Archived is not deleted. The class and everything under it stays
  // reachable; only the listings hide it. A semester's notes are exactly
  // what someone wants back a year later.
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null

  version: number
  dirty: boolean
  syncedAt: string | null
}

export type Notebook = {
  id: string
  // Null is a notebook that belongs to no class, which is allowed.
  classId: string | null
  name: string
  // The notebook created with its class. Renameable but not deletable, a
  // rule enforced in deleteNotebook rather than only in the UI.
  isGeneral: boolean
  // A collegebook is a notebook whose notes are pages. The two are one table
  // and one sync type on purpose: a page is a note with an order, and nothing
  // below this line needs to know the difference.
  kind: 'notes' | 'collegebook'
  // A collegebook's appearance, as the JSON text the server stores, and null
  // for a book that has set nothing. Text rather than a parsed object so that
  // keys written by a newer client survive being read and written here — see
  // db/settings.ts, which is the only thing that looks inside it.
  settings: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null

  version: number
  dirty: boolean
  syncedAt: string | null
}

// A link from a deadline into the reader's own notes: what to revise, and
// where to find it. The heading text always, and the note id with it wherever
// the topic was picked from a note — the text alone dangles the moment a
// heading is renamed, and the id alone cannot say which part of a long note is
// meant. Together they degrade gracefully: the note still opens, and the
// heading is either found or reported missing.
//
// A null noteId is a topic nobody has written up yet. A student revises what is
// on the syllabus, not only what is already in their notes, so it is kept as
// text that links nowhere rather than refused.
export type Topic = {
  noteId: string | null
  heading: string
}

export type Deadline = {
  id: string
  // Null is a loose deadline, which belongs to no class and is a real case.
  classId: string | null
  title: string
  kind: 'test' | 'assignment' | 'other'
  // A date, not a moment: ISO 8601 at midnight UTC, so it matches how every
  // other timestamp here is stored and sorts lexically. The time component
  // means nothing and nothing may read it — a test is on Friday, not at
  // 14:30. See db/deadlines.ts for what "today" means against it.
  dueAt: string
  note: string | null
  // Parsed, unlike a notebook's settings, because the client is what
  // understands a topic — a picker reads these, the server never does. They
  // are serialised to JSON at the wire boundary and nowhere else, and nothing
  // rebuilds the objects, so a key written by a newer client survives.
  topics: Topic[]
  // Set means ticked off. Not deletedAt: a finished deadline is still a
  // deadline and still syncs.
  doneAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null

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

  // Only what is queried is indexed. `dirty` and `isGeneral` are booleans,
  // and a boolean is not a valid IndexedDB key, so an index on either would
  // stay permanently empty — the trap v1 walked into with `dirty` above.
  // Reads of those two fields filter in memory on purpose.
  db.version(4)
    .stores({
      classes: 'id, name, archivedAt, updatedAt, deletedAt',
      notebooks: 'id, classId, name, updatedAt, deletedAt',
      notes: 'id, updatedAt, deletedAt, dirty, classId, searchText, notebookId',
    })
    .upgrade((tx) =>
      // Unfiled, which is correct and requires no guessing: no notebook on
      // this device can be the home of a note written before notebooks
      // existed. Deleted rows are backfilled too, because a restore brings
      // one back and it would otherwise return with notebookId undefined,
      // which no filter matches.
      tx
        .table<Note>('notes')
        .toCollection()
        .modify((note) => {
          note.notebookId = null
        }),
    )

  // No new index. pageOrder is read through the notebookId index and sorted
  // in memory, which is the same trade the rest of this file makes: an index
  // is a version bump, and a page list is one collegebook long.
  db.version(5).upgrade(async (tx) => {
    // Both tables are rewritten, deleted rows included. A restore brings one
    // back, and it would otherwise return with the field undefined — a value
    // no filter matches, which is the trap v4's comment above describes.
    await tx
      .table<Notebook>('notebooks')
      .toCollection()
      .modify((notebook) => {
        // Every notebook already on a device is one of notes: until this
        // version there was no way to make anything else.
        notebook.kind = 'notes'
      })
    await tx
      .table<Note>('notes')
      .toCollection()
      .modify((note) => {
        note.pageOrder = null
      })
  })

  // No new index and no new store: settings are read with the notebook they
  // belong to and are never queried on. The column rides the existing
  // notebook sync, so there is no new wire type and no cursor change either.
  db.version(6).upgrade((tx) =>
    // Null, not a blob of the current defaults. Null means "this book has set
    // nothing", which is what these books have done, and it is what lets a
    // later change to the defaults reach them. Writing defaults in here would
    // freeze today's appearance onto every book that ever existed.
    //
    // Deleted rows too, for the reason v4 and v5 backfilled theirs: a restore
    // brings one back, and it would otherwise return with the field undefined
    // — a value no filter matches. The write leaves dirty alone, so this does
    // not queue a push of every notebook on the device.
    tx
      .table<Notebook>('notebooks')
      .toCollection()
      .modify((notebook) => {
        notebook.settings = null
      }),
  )

  // A new store, so this is a delta like v3's and needs no upgrade function:
  // a device arriving at v7 has never held a deadline, and there is nothing
  // to backfill.
  //
  // dueAt is indexed because listUpcoming and listOverdue order by it. doneAt
  // is not, and deliberately: it is null on every outstanding deadline, a
  // null never enters an IndexedDB index, so an index there would hold the
  // ticked-off rows only — the exact inversion of what those two reads want.
  // They filter it in memory, as the rest of this file filters dirty.
  db.version(7).stores({
    deadlines: 'id, classId, dueAt, updatedAt, deletedAt',
  })
}

export const db = new Dexie('nefix') as Dexie & {
  notes: EntityTable<Note, 'id'>
  classes: EntityTable<Class, 'id'>
  notebooks: EntityTable<Notebook, 'id'>
  deadlines: EntityTable<Deadline, 'id'>
  meta: EntityTable<Meta, 'key'>
}

declareSchema(db)
