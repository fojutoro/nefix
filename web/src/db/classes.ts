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

// By name rather than by recency: a class list is a semester's timetable and
// should sit still, unlike the note list, which is a work queue.
export async function listClasses(): Promise<Class[]> {
  return db.classes
    .orderBy('name')
    .filter((row) => row.deletedAt === null && row.archivedAt === null)
    .toArray()
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
