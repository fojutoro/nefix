import { db, type Notebook } from './schema.ts'
import { uuidv7 } from './uuid.ts'

const now = () => new Date().toISOString()

export async function createNotebook(
  name: string,
  classId: string | null = null,
): Promise<Notebook> {
  const timestamp = now()
  const notebook: Notebook = {
    id: uuidv7(),
    classId,
    name,
    // Only createClass makes a general notebook, and it does so directly.
    isGeneral: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    version: 0,
    dirty: true,
    syncedAt: null,
  }
  await db.notebooks.add(notebook)
  return notebook
}

export async function getNotebook(id: string): Promise<Notebook | undefined> {
  const found = await db.notebooks.get(id)
  return found?.deletedAt === null ? found : undefined
}

// Undefined lists every notebook, a class id lists that class's. A notebook
// belonging to no class is reached through the unfiltered listing.
export async function listNotebooks(classId?: string): Promise<Notebook[]> {
  return db.notebooks
    .orderBy('name')
    .filter(
      (row) =>
        row.deletedAt === null &&
        (classId === undefined || row.classId === classId),
    )
    .toArray()
}

export async function updateNotebook(
  id: string,
  patch: { name?: string; classId?: string | null },
): Promise<void> {
  await db.transaction('rw', db.notebooks, async () => {
    const found = await db.notebooks.get(id)
    if (!found || found.deletedAt !== null) {
      throw new Error(`notebook ${id} not found`)
    }
    await db.notebooks.update(id, {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.classId !== undefined && { classId: patch.classId }),
      updatedAt: now(),
      dirty: true,
    })
  })
}

// The notes are unfiled, never deleted. Losing notes because the container
// around them was removed is not a tradeoff worth making, and an unfiled
// note is a state the app already handles everywhere.
export async function deleteNotebook(id: string): Promise<void> {
  const timestamp = now()
  await db.transaction('rw', db.notebooks, db.notes, async () => {
    const found = await db.notebooks.get(id)
    if (!found || found.deletedAt !== null) {
      throw new Error(`notebook ${id} not found`)
    }
    // Here rather than only in the UI, so the rule lives with the data and
    // holds for whatever calls this later.
    if (found.isGeneral) {
      throw new Error(`notebook ${id} is general and cannot be deleted`)
    }
    await db.notebooks.update(id, {
      deletedAt: timestamp,
      updatedAt: timestamp,
      dirty: true,
    })
    // dirty, because the move is a change the server has to be told about.
    await db.notes
      .where('notebookId')
      .equals(id)
      .modify({ notebookId: null, updatedAt: timestamp, dirty: true })
  })
}
