import { db, type Deadline, type Topic } from './schema.ts'
import { uuidv7 } from './uuid.ts'

// Every mutation sets dirty: true. The push queue reads that flag, so a
// mutation that forgets it produces a deadline that never syncs and gives no
// sign of it.

const now = () => new Date().toISOString()

// "Today" is the reader's today, taken from their own calendar, and never
// UTC. A student in Bratislava at 01:00 on Friday is already on Friday while
// UTC is still on Thursday; a reader in New York at 22:00 on Thursday is
// still on Thursday while UTC has moved to Friday. Both would be told the
// wrong thing by a UTC answer, in opposite directions.
//
// Normalising this to UTC for consistency with the way dueAt is stored is
// exactly the bug, not the fix — the storage format and the reader's calendar
// are different questions. Do not "tidy" it.
//
// Formatted rather than computed: timezone bugs live in the arithmetic, and
// YYYY-MM-DD compares lexically against the date half of a dueAt with none of
// it.
function today(): string {
  const local = new Date()
  const month = String(local.getMonth() + 1).padStart(2, '0')
  const date = String(local.getDate()).padStart(2, '0')

  return `${local.getFullYear()}-${month}-${date}`
}

// The date half of a dueAt. Its time component is midnight UTC and means
// nothing, so nothing compares against it.
const dayOf = (deadline: Deadline): string => deadline.dueAt.slice(0, 10)

export async function createDeadline(input: {
  title: string
  dueAt: string
  kind?: Deadline['kind']
  classId?: string | null
  note?: string | null
  topics?: Topic[]
}): Promise<Deadline> {
  const timestamp = now()
  const deadline: Deadline = {
    id: uuidv7(),
    classId: input.classId ?? null,
    title: input.title,
    kind: input.kind ?? 'other',
    dueAt: input.dueAt,
    note: input.note ?? null,
    topics: input.topics ?? [],
    doneAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    version: 0,
    dirty: true,
    syncedAt: null,
  }
  await db.deadlines.add(deadline)
  return deadline
}

export async function updateDeadline(
  id: string,
  patch: {
    title?: string
    dueAt?: string
    kind?: Deadline['kind']
    classId?: string | null
    note?: string | null
    topics?: Topic[]
  },
): Promise<void> {
  await db.transaction('rw', db.deadlines, async () => {
    const found = await db.deadlines.get(id)
    if (!found || found.deletedAt !== null) {
      throw new Error(`deadline ${id} not found`)
    }
    await db.deadlines.update(id, {
      // Spreading patch would write undefined over a field the caller simply
      // did not mention.
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.dueAt !== undefined && { dueAt: patch.dueAt }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(patch.classId !== undefined && { classId: patch.classId }),
      ...(patch.note !== undefined && { note: patch.note }),
      ...(patch.topics !== undefined && { topics: patch.topics }),
      updatedAt: now(),
      dirty: true,
    })
  })
}

// A delete bumps updatedAt like any other mutation, and the row stays: a hard
// delete would leave sync unable to tell "deleted" from "never existed", so
// the deadline would return on the next pull.
export async function deleteDeadline(id: string): Promise<void> {
  const timestamp = now()
  await db.deadlines.update(id, {
    deletedAt: timestamp,
    updatedAt: timestamp,
    dirty: true,
  })
}

// Ticking off and un-ticking are one gesture. A timestamp rather than a flag,
// so a dashboard can say when it was finished, and never deletedAt: a done
// deadline is still a deadline.
export async function toggleDone(id: string): Promise<void> {
  await db.transaction('rw', db.deadlines, async () => {
    const found = await db.deadlines.get(id)
    if (!found || found.deletedAt !== null) {
      throw new Error(`deadline ${id} not found`)
    }
    const timestamp = now()
    await db.deadlines.update(id, {
      doneAt: found.doneAt === null ? timestamp : null,
      updatedAt: timestamp,
      dirty: true,
    })
  })
}

// The argument is the value being matched rather than a sentinel to remember:
// undefined asks for every deadline, a string for that class's, and null for
// the loose ones, which is exactly what those rows hold. Same convention as
// listNotes.
export async function listDeadlines(
  classId?: string | null,
): Promise<Deadline[]> {
  return db.deadlines
    .orderBy('dueAt')
    .filter(
      (row) =>
        row.deletedAt === null &&
        (classId === undefined || row.classId === classId),
    )
    .toArray()
}

// What the general dashboard reads: outstanding, due today or later, soonest
// first. Due today is upcoming and never overdue — see today() above.
export async function listUpcoming(limit: number): Promise<Deadline[]> {
  const day = today()
  return db.deadlines
    .orderBy('dueAt')
    .filter(
      (row) => row.deletedAt === null && row.doneAt === null && dayOf(row) >= day,
    )
    .limit(limit)
    .toArray()
}

// The complement of listUpcoming, on the same boundary: outstanding and
// already past. Soonest first, so the oldest miss is at the top.
export async function listOverdue(): Promise<Deadline[]> {
  const day = today()
  return db.deadlines
    .orderBy('dueAt')
    .filter(
      (row) => row.deletedAt === null && row.doneAt === null && dayOf(row) < day,
    )
    .toArray()
}
