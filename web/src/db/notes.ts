import { liveQuery, type Observable } from 'dexie'
import { db, searchTextOf, type Note } from './schema.ts'
import { uuidv7 } from './uuid.ts'

// Every mutation sets dirty: true. Phase 4's push queue reads that flag,
// so a mutation that forgets it produces a note that never syncs and
// gives no sign of it.

export async function createNote(input: {
  title?: string
  bodyMd?: string
  notebookId?: string | null
}): Promise<Note> {
  const now = new Date().toISOString()
  const title = input.title ?? ''
  const bodyMd = input.bodyMd ?? ''
  const note: Note = {
    id: uuidv7(),
    // Never set. See the comment on Note.classId: the server decodes it as
    // an integer and a non-null value is a 400.
    classId: null,
    notebookId: input.notebookId ?? null,
    title,
    bodyMd,
    searchText: searchTextOf(title, bodyMd),
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    forkedFromId: null,
    version: 0,
    dirty: true,
    syncedAt: null,
  }
  await db.notes.add(note)
  return note
}

export async function getNote(id: string): Promise<Note | undefined> {
  const note = await db.notes.get(id)
  return note?.deletedAt === null ? note : undefined
}

// The argument is the value being matched rather than a sentinel to
// remember: undefined asks for every note, a string for that notebook, and
// null for the unfiled ones, which is exactly what those notes hold. A
// separate listUnfiledNotes would be a second function to keep in step with
// this one's ordering and its delete filter.
export async function listNotes(notebookId?: string | null): Promise<Note[]> {
  return db.notes
    .orderBy('updatedAt')
    .reverse()
    .filter(
      (note) =>
        note.deletedAt === null &&
        (notebookId === undefined || note.notebookId === notebookId),
    )
    .toArray()
}

export async function updateNote(
  id: string,
  patch: { title?: string; bodyMd?: string },
): Promise<void> {
  await db.transaction('rw', db.notes, async () => {
    const note = await db.notes.get(id)
    if (!note || note.deletedAt !== null) {
      throw new Error(`note ${id} not found`)
    }
    await db.notes.update(id, {
      // Spreading patch would write undefined over a field the caller
      // simply did not mention.
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.bodyMd !== undefined && { bodyMd: patch.bodyMd }),
      // Derived from the merged values, not from the patch: a body-only
      // edit still has to keep the title in the search text.
      searchText: searchTextOf(
        patch.title ?? note.title,
        patch.bodyMd ?? note.bodyMd,
      ),
      updatedAt: new Date().toISOString(),
      dirty: true,
    })
  })
}

// A delete and a restore bump updatedAt like any other mutation. Phase 4
// pulls with updatedAt as its cursor, so one that left the field alone
// would be invisible to sync and the note would return on the next pull.
export async function deleteNote(id: string): Promise<void> {
  const now = new Date().toISOString()
  await db.notes.update(id, { deletedAt: now, updatedAt: now, dirty: true })
}

export async function restoreNote(id: string): Promise<void> {
  await db.notes.update(id, {
    deletedAt: null,
    updatedAt: new Date().toISOString(),
    dirty: true,
  })
}

export async function countNotes(): Promise<number> {
  return db.notes.filter((note) => note.deletedAt === null).count()
}

// The rail's Unfiled count. Hidden at zero rather than shown as an empty
// bucket, so the number is what decides whether the row exists at all.
export async function countUnfiledNotes(): Promise<number> {
  return db.notes
    .filter((note) => note.deletedAt === null && note.notebookId === null)
    .count()
}

// Every unsynced row, not only notes: clearEverything takes all three tables,
// so a count that named only notes would let the sign-out confirmation
// promise there was nothing to lose and then delete a class rename.
//
// Deleted ones included: a soft delete that has not reached the server is
// unsynced work like any other, and signing out would lose it.
export async function countDirtyRows(): Promise<number> {
  const counts = await Promise.all([
    db.notes.filter((row) => row.dirty).count(),
    db.classes.filter((row) => row.dirty).count(),
    db.notebooks.filter((row) => row.dirty).count(),
  ])
  return counts.reduce((total, count) => total + count, 0)
}

// Signing out on a shared or university machine has to mean the notes are
// gone, so the sync cursor and the remembered note go with them: a cursor
// left behind would tell the next account's pull that it is already caught
// up on notes this device has never held.
export async function clearEverything(): Promise<void> {
  const tables = [db.notes, db.classes, db.notebooks, db.meta]
  await db.transaction('rw', tables, async () => {
    for (const table of tables) await table.clear()
  })
}

// liveQuery rather than a counter handed down from the sync cycle: the
// editor watches the row it is showing and never learns that a pull exists.
// The raw row, not getNote: the caller needs `dirty` to decide whether the
// change is safe to take.
export function observeNote(id: string): Observable<Note | undefined> {
  return liveQuery(() => db.notes.get(id))
}

// Beside the notes it points at rather than in localStorage, for the reason
// the sync cursor is: cleared on its own, it would name a note this database
// no longer holds.
const LAST_NOTE = 'lastNoteId'

export async function readLastNoteId(): Promise<string | null> {
  const row = await db.meta.get(LAST_NOTE)
  if (typeof row?.value !== 'string') return null
  // getNote answers undefined for a note that was deleted as well as for one
  // that was never here, and neither may be handed back as something to open.
  return (await getNote(row.value)) === undefined ? null : row.value
}

export async function writeLastNoteId(id: string | null): Promise<void> {
  if (id === null) await db.meta.delete(LAST_NOTE)
  else await db.meta.put({ key: LAST_NOTE, value: id })
}
