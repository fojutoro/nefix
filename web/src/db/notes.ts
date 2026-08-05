import { db, searchTextOf, type Note } from './schema.ts'
import { uuidv7 } from './uuid.ts'

// Every mutation sets dirty: true. Phase 4's push queue reads that flag,
// so a mutation that forgets it produces a note that never syncs and
// gives no sign of it.

export async function createNote(input: {
  title?: string
  bodyMd?: string
  classId?: string | null
}): Promise<Note> {
  const now = new Date().toISOString()
  const title = input.title ?? ''
  const bodyMd = input.bodyMd ?? ''
  const note: Note = {
    id: uuidv7(),
    classId: input.classId ?? null,
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

export async function listNotes(): Promise<Note[]> {
  return db.notes
    .orderBy('updatedAt')
    .reverse()
    .filter((note) => note.deletedAt === null)
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
