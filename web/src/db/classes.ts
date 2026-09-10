import i18n from '../i18n/index.ts'
import { db, type Class, type Notebook } from './schema.ts'
import { uuidv7 } from './uuid.ts'

// Every mutation sets dirty: true, as with notes. The push queue reads that
// flag, so a mutation that forgets it produces a row that never syncs and
// gives no sign of it.

const now = () => new Date().toISOString()

export async function createClass(input: {
  name: string
  code?: string
  colour?: string
  semester?: string
}): Promise<Class> {
  const timestamp = now()
  const created: Class = {
    id: uuidv7(),
    name: input.name,
    code: input.code ?? null,
    colour: input.colour ?? null,
    semester: input.semester ?? null,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    version: 0,
    dirty: true,
    syncedAt: null,
  }
  const general: Notebook = {
    id: uuidv7(),
    classId: created.id,
    name: i18n.t('notebooks.general'),
    isGeneral: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    version: 0,
    dirty: true,
    syncedAt: null,
  }

  // One transaction, because the two rows are one unit of meaning: a class
  // whose notebook did not get written is a class with nowhere to type, and
  // half of this pair reaching the database is worse than neither.
  await db.transaction('rw', db.classes, db.notebooks, async () => {
    await db.classes.add(created)
    await db.notebooks.add(general)
  })

  return created
}

export async function getClass(id: string): Promise<Class | undefined> {
  const found = await db.classes.get(id)
  return found?.deletedAt === null ? found : undefined
}

// The rail's ordering column, carried with the class because the same scan
// produces both: the value shown on the row and the key it is sorted by.
export type ClassWithRecency = Class & { latestNoteAt: string | null }

// By recency and not by name, because the dominant axis for a student is
// time: the class you were just in belongs at the top, where your hand
// already is, and "Analýza, three weeks" is the app naming what you have
// been neglecting. A name-ordered rail can say neither.
export async function listClasses(): Promise<ClassWithRecency[]> {
  const [classes, notebooks] = await Promise.all([
    // Name order is the tie-break underneath the sort below, which is what
    // orders the classes that have no notes at all.
    db.classes
      .orderBy('name')
      .filter((row) => row.deletedAt === null && row.archivedAt === null)
      .toArray(),
    db.notebooks.filter((row) => row.deletedAt === null).toArray(),
  ])

  const classOfNotebook = new Map(notebooks.map((row) => [row.id, row.classId]))
  const latest = new Map<string, string>()
  await db.notes.each((note) => {
    if (note.deletedAt !== null || note.notebookId === null) return
    const classId = classOfNotebook.get(note.notebookId)
    if (classId === undefined || classId === null) return
    const known = latest.get(classId)
    // ISO 8601 UTC throughout, so the newest is the lexical maximum.
    if (known === undefined || note.updatedAt > known) {
      latest.set(classId, note.updatedAt)
    }
  })

  return classes
    .map((row) => ({ ...row, latestNoteAt: latest.get(row.id) ?? null }))
    .sort((a, b) => (b.latestNoteAt ?? '').localeCompare(a.latestNoteAt ?? ''))
}

export async function listArchivedClasses(): Promise<Class[]> {
  return db.classes
    .orderBy('name')
    .filter((row) => row.deletedAt === null && row.archivedAt !== null)
    .toArray()
}

export async function updateClass(
  id: string,
  patch: {
    name?: string
    code?: string | null
    colour?: string | null
    semester?: string | null
  },
): Promise<void> {
  await db.transaction('rw', db.classes, async () => {
    const found = await db.classes.get(id)
    if (!found || found.deletedAt !== null) {
      throw new Error(`class ${id} not found`)
    }
    await db.classes.update(id, {
      // Spreading patch would write undefined over a field the caller
      // simply did not mention.
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.code !== undefined && { code: patch.code }),
      ...(patch.colour !== undefined && { colour: patch.colour }),
      ...(patch.semester !== undefined && { semester: patch.semester }),
      updatedAt: now(),
      dirty: true,
    })
  })
}

// Archiving touches the class row and nothing else. Its notebooks and notes
// stay exactly as they are, which is the whole point of archiving rather
// than deleting: a semester's notes are what someone wants back a year later.
export async function archiveClass(id: string): Promise<void> {
  const timestamp = now()
  await db.classes.update(id, {
    archivedAt: timestamp,
    updatedAt: timestamp,
    dirty: true,
  })
}

export async function unarchiveClass(id: string): Promise<void> {
  await db.classes.update(id, {
    archivedAt: null,
    updatedAt: now(),
    dirty: true,
  })
}

// Soft, as with notes: a hard delete would leave sync unable to tell
// "deleted" from "never existed" and the class would return on the next
// pull. Its notebooks and notes are left alone here too.
export async function deleteClass(id: string): Promise<void> {
  const timestamp = now()
  await db.classes.update(id, {
    deletedAt: timestamp,
    updatedAt: timestamp,
    dirty: true,
  })
}

// The number that goes into the sentence asking for consent to destroy them.
// Read at the moment of confirming rather than taken from whatever the page
// had loaded: "delete 14 notes" in front of forty is a dialog that lied to
// get the answer it wanted.
export async function countNotesInClass(id: string): Promise<number> {
  const notebooks = await db.notebooks
    .where('classId')
    .equals(id)
    .and((row) => row.deletedAt === null)
    .toArray()
  if (notebooks.length === 0) return 0
  return db.notes
    .where('notebookId')
    .anyOf(notebooks.map((row) => row.id))
    .and((row) => row.deletedAt === null)
    .count()
}

// Archiving is the gentle option and the one the menu offers first. This is
// the other one: everything under the class goes with it.
//
// Soft, like every other delete here, and dirty on all three tables. A hard
// delete would leave sync unable to tell "deleted" from "never existed", and
// the notes are the rows that would otherwise become orphans — invisible on
// this device and back on the next pull.
export async function deleteClassCascade(id: string): Promise<void> {
  const timestamp = now()
  await db.transaction('rw', db.classes, db.notebooks, db.notes, async () => {
    const notebooks = await db.notebooks
      .where('classId')
      .equals(id)
      .and((row) => row.deletedAt === null)
      .toArray()
    if (notebooks.length > 0) {
      await db.notes
        .where('notebookId')
        .anyOf(notebooks.map((row) => row.id))
        // Already-deleted rows are left alone: re-stamping one would push a
        // row the server has and move a date that means something.
        .and((row) => row.deletedAt === null)
        .modify({ deletedAt: timestamp, updatedAt: timestamp, dirty: true })
      await db.notebooks
        .where('classId')
        .equals(id)
        .and((row) => row.deletedAt === null)
        .modify({ deletedAt: timestamp, updatedAt: timestamp, dirty: true })
    }
    await deleteClass(id)
  })
}

// Two keys, not one. The selected class and the class to write in are the
// same id most of the time and must not be: selecting Today may not lose
// where `n` puts a note.
const LAST_CLASS = 'lastClassId'
const LAST_WRITTEN_CLASS = 'lastWrittenClassId'

// A remembered id is a claim about a row that may have been deleted or
// archived since, on this device or on another one through sync. Validating
// on the way out is what keeps a dangling id from rendering a class that is
// not there, and it belongs here rather than in each caller.
async function readClassRef(key: string): Promise<string | null> {
  const row = await db.meta.get(key)
  if (typeof row?.value !== 'string') return null
  const found = await getClass(row.value)
  return found === undefined || found.archivedAt !== null ? null : row.value
}

async function writeClassRef(key: string, id: string | null): Promise<void> {
  if (id === null) await db.meta.delete(key)
  else await db.meta.put({ key, value: id })
}

export const readLastClassId = () => readClassRef(LAST_CLASS)
export const writeLastClassId = (id: string | null) =>
  writeClassRef(LAST_CLASS, id)

export const readLastWrittenClassId = () => readClassRef(LAST_WRITTEN_CLASS)
export const writeLastWrittenClassId = (id: string | null) =>
  writeClassRef(LAST_WRITTEN_CLASS, id)
