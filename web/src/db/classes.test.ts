import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archiveClass,
  countNotesInClass,
  createClass,
  deleteClass,
  deleteClassCascade,
  getClass,
  listArchivedClasses,
  listClasses,
  readLastClassId,
  readLastWrittenClassId,
  unarchiveClass,
  updateClass,
  writeLastClassId,
  writeLastWrittenClassId,
} from './classes.ts'
import { createNotebook, listNotebooks } from './notebooks.ts'
import { createNote, deleteNote } from './notes.ts'
import { db } from './schema.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

beforeEach(async () => {
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
  await db.meta.clear()
})

describe('createClass', () => {
  it('writes the class and its general notebook, both dirty', async () => {
    const created = await createClass({
      name: 'Diskrétna matematika',
      code: '1-AIN-101',
      colour: '#3355ff',
      semester: '2026Z',
    })

    const classes = await db.classes.toArray()
    expect(classes).toHaveLength(1)
    expect(classes[0]).toMatchObject({
      id: created.id,
      name: 'Diskrétna matematika',
      code: '1-AIN-101',
      colour: '#3355ff',
      semester: '2026Z',
      archivedAt: null,
      deletedAt: null,
      version: 0,
      dirty: true,
      syncedAt: null,
    })

    // A class you cannot type in is the failure this pairing exists to
    // prevent, so the notebook is asserted as a row and not as a return value.
    const notebooks = await db.notebooks.toArray()
    expect(notebooks).toHaveLength(1)
    expect(notebooks[0]).toMatchObject({
      classId: created.id,
      isGeneral: true,
      deletedAt: null,
      version: 0,
      dirty: true,
      syncedAt: null,
    })
    expect(notebooks[0]!.name).not.toBe('')
    expect(notebooks[0]!.id).not.toBe(created.id)
  })

  it('leaves neither row when the notebook write fails', async () => {
    // The two rows are one unit of meaning. Written outside a transaction
    // the class survives this and the user has a class with nowhere to
    // type, which is exactly the state the pairing exists to rule out.
    const add = vi
      .spyOn(db.notebooks, 'add')
      .mockRejectedValueOnce(new Error('quota exceeded'))

    await expect(createClass({ name: 'Diskrétna matematika' })).rejects.toThrow(
      'quota exceeded',
    )

    expect(await db.classes.count()).toBe(0)
    expect(await db.notebooks.count()).toBe(0)

    add.mockRestore()
  })
})

// Every class in this block is created with a note whose updatedAt is
// written directly, because createNote stamps now() and four classes created
// in one tick are indistinguishable by recency.
async function noteIn(classId: string, updatedAt: string) {
  const notebook = (await listNotebooks(classId))[0]!
  const note = await createNote({ notebookId: notebook.id })
  await db.notes.update(note.id, { updatedAt })
  return note
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

describe('listClasses', () => {
  it('orders by the most recent note in the class, not by name', async () => {
    // The two orders disagree on purpose. Alphabetically this is Analýza,
    // Diskrétna, Lineárna, Zoológia; by recency it is Diskrétna, Lineárna,
    // Analýza, Zoológia. A test built on classes whose alphabet already
    // matches their recency passes against `orderBy('name')`.
    const analysis = await createClass({ name: 'Analýza' })
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const algebra = await createClass({ name: 'Lineárna algebra' })
    const zoology = await createClass({ name: 'Zoológia' })
    await noteIn(analysis.id, ago(21 * 86_400_000))
    await noteIn(discrete.id, ago(2 * 3_600_000))
    await noteIn(algebra.id, ago(2 * 86_400_000))

    expect((await listClasses()).map((c) => c.id)).toEqual([
      discrete.id,
      algebra.id,
      analysis.id,
      // Last, and with nothing to show in the column: the class exists and
      // has to be reachable, but it has never been written in.
      zoology.id,
    ])
  })

  it('carries the timestamp of the most recent note, and null without one', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const zoology = await createClass({ name: 'Zoológia' })
    const untouched = await createClass({ name: 'Fyzika' })
    await noteIn(discrete.id, ago(3 * 86_400_000))
    const newest = await noteIn(discrete.id, ago(2 * 3_600_000))
    // Deleted last, so deleteNote's own updatedAt stamp is the newest in the
    // database: counted, it would be this class's timestamp and its order.
    const deleted = await noteIn(discrete.id, ago(60_000))
    await deleteNote(deleted.id)
    const zooNote = await noteIn(zoology.id, ago(5 * 86_400_000))

    const rows = await listClasses()
    const shown = (id: string) => rows.find((row) => row.id === id)!
    expect(shown(discrete.id).latestNoteAt).toBe(
      (await db.notes.get(newest.id))!.updatedAt,
    )
    // Its own note, not the newest note anywhere.
    expect(shown(zoology.id).latestNoteAt).toBe(
      (await db.notes.get(zooNote.id))!.updatedAt,
    )
    expect(shown(untouched.id).latestNoteAt).toBeNull()
    expect(rows.map((row) => row.id)).toEqual([
      discrete.id,
      zoology.id,
      untouched.id,
    ])
  })

  it('excludes archived and deleted classes', async () => {
    const algebra = await createClass({ name: 'Lineárna algebra' })
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const old = await createClass({ name: 'Fyzika' })
    const gone = await createClass({ name: 'Zmazaný' })
    await noteIn(discrete.id, ago(3_600_000))
    await archiveClass(old.id)
    await deleteClass(gone.id)

    expect((await listClasses()).map((c) => c.id)).toEqual([
      discrete.id,
      algebra.id,
    ])
    expect((await listArchivedClasses()).map((c) => c.id)).toEqual([old.id])
  })
})

describe('the remembered class', () => {
  it('reads back what was written', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })

    await writeLastClassId(created.id)

    expect(await readLastClassId()).toBe(created.id)
  })

  it('answers null for a class that is not in the database', async () => {
    await writeLastClassId('no-such-class')

    expect(await readLastClassId()).toBeNull()
  })

  it('answers null for a deleted class', async () => {
    const created = await createClass({ name: 'Zmazaný' })
    await writeLastClassId(created.id)

    await deleteClass(created.id)

    expect(await readLastClassId()).toBeNull()
  })

  it('answers null for an archived class', async () => {
    // Archived is reachable, but it is not somewhere to land on a cold start.
    const created = await createClass({ name: 'Fyzika' })
    await writeLastClassId(created.id)

    await archiveClass(created.id)

    expect(await readLastClassId()).toBeNull()
  })

  it('forgets the class when null is written', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    await writeLastClassId(created.id)

    await writeLastClassId(null)

    expect(await readLastClassId()).toBeNull()
    expect(await db.meta.get('lastClassId')).toBeUndefined()
  })

  // The same validation, because `n` reads this one on a cold start and a
  // dangling id would put the note in a class that is not there.
  it('validates the last written-in class the same way', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    await writeLastWrittenClassId(created.id)
    expect(await readLastWrittenClassId()).toBe(created.id)

    await archiveClass(created.id)

    expect(await readLastWrittenClassId()).toBeNull()
    // Two separate keys: selecting Today may not forget where to write.
    expect(await readLastClassId()).toBeNull()
  })
})

describe('archiveClass', () => {
  it('leaves the notebooks and notes of the class untouched', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    const notebook = (await db.notebooks.toArray())[0]!
    const note = await createNote({
      title: 'Množiny',
      bodyMd: '# Množiny',
      notebookId: notebook.id,
    })
    await db.notebooks.update(notebook.id, { dirty: false })
    await db.notes.update(note.id, { dirty: false })
    await tick()

    await archiveClass(created.id)

    const archived = await getClass(created.id)
    expect(archived?.archivedAt).not.toBeNull()
    expect(archived?.dirty).toBe(true)
    expect(archived!.updatedAt > created.updatedAt).toBe(true)
    // Not deleted. A semester's notes are what someone wants back a year
    // later, so archiving may not touch anything underneath it.
    expect(archived?.deletedAt).toBeNull()

    expect(await db.notebooks.get(notebook.id)).toEqual({
      ...notebook,
      dirty: false,
    })
    expect(await db.notes.get(note.id)).toEqual({ ...note, dirty: false })
  })

  it('unarchives', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    await archiveClass(created.id)

    await unarchiveClass(created.id)

    expect((await getClass(created.id))?.archivedAt).toBeNull()
    expect((await listClasses()).map((c) => c.id)).toEqual([created.id])
  })
})

describe('updateClass', () => {
  it('changes only the named fields and sets dirty', async () => {
    const created = await createClass({ name: 'Diskrétna', code: '1-AIN-101' })
    await db.classes.update(created.id, { dirty: false })
    await tick()

    await updateClass(created.id, { name: 'Diskrétna matematika' })

    const updated = await getClass(created.id)
    expect(updated?.name).toBe('Diskrétna matematika')
    expect(updated?.code).toBe('1-AIN-101')
    expect(updated?.dirty).toBe(true)
    expect(updated!.updatedAt > created.updatedAt).toBe(true)
  })

  it('throws on a missing id', async () => {
    await expect(updateClass('nope', { name: 'x' })).rejects.toThrow()
  })
})

describe('deleteClass', () => {
  it('soft-deletes, keeping the row for sync', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })

    await deleteClass(created.id)

    expect(await getClass(created.id)).toBeUndefined()
    const row = await db.classes.get(created.id)
    expect(row?.deletedAt).not.toBeNull()
    expect(row?.dirty).toBe(true)
  })
})

describe('countNotesInClass', () => {
  it('counts the live notes across every notebook of the class', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const other = await createClass({ name: 'Zoológia' })
    const second = await createNotebook('Cvičenia', discrete.id)
    await noteIn(discrete.id, ago(0))
    await noteIn(discrete.id, ago(0))
    const note = await createNote({ notebookId: second.id })
    // Neither a deleted note nor another class's note is in this count, and
    // the number goes into a sentence asking for consent to destroy them.
    const gone = await noteIn(discrete.id, ago(0))
    await deleteNote(gone.id)
    await noteIn(other.id, ago(0))

    expect(await countNotesInClass(discrete.id)).toBe(3)
    expect(note.notebookId).toBe(second.id)
    expect(await countNotesInClass(other.id)).toBe(1)
  })

  it('counts nothing for a class that has never been written in', async () => {
    const created = await createClass({ name: 'Zoológia' })

    expect(await countNotesInClass(created.id)).toBe(0)
  })
})

describe('deleteClassCascade', () => {
  it('soft-deletes the class, its notebooks and its notes, all dirty', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const second = await createNotebook('Cvičenia', discrete.id)
    const first = await noteIn(discrete.id, ago(0))
    const inSecond = await createNote({ notebookId: second.id })
    const other = await createClass({ name: 'Zoológia' })
    const elsewhere = await noteIn(other.id, ago(0))
    // Clean to start with, so `dirty` below is this call's work and not the
    // leftover flag from creating the fixture.
    await db.classes.toCollection().modify({ dirty: false })
    await db.notebooks.toCollection().modify({ dirty: false })
    await db.notes.toCollection().modify({ dirty: false })
    await tick()

    await deleteClassCascade(discrete.id)

    // The class.
    const row = await db.classes.get(discrete.id)
    expect(row?.deletedAt).not.toBeNull()
    expect(row?.dirty).toBe(true)
    expect(await getClass(discrete.id)).toBeUndefined()

    // Both notebooks, the general one and the one added later.
    const notebooks = await db.notebooks
      .where('classId')
      .equals(discrete.id)
      .toArray()
    expect(notebooks).toHaveLength(2)
    for (const notebook of notebooks) {
      expect(notebook.deletedAt).not.toBeNull()
      expect(notebook.dirty).toBe(true)
    }

    // And the notes, which are the rows that would otherwise be orphans:
    // invisible on this device and back the moment the server is asked.
    for (const id of [first.id, inSecond.id]) {
      const note = await db.notes.get(id)
      expect(note?.deletedAt).not.toBeNull()
      expect(note?.dirty).toBe(true)
      expect(note!.updatedAt > first.updatedAt).toBe(true)
    }

    // Nothing outside the class is touched.
    expect(await db.notes.get(elsewhere.id)).toMatchObject({
      deletedAt: null,
      dirty: false,
    })
    expect(await getClass(other.id)).toBeDefined()
  })

  it('leaves a note that was already deleted as it was', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const gone = await noteIn(discrete.id, ago(0))
    await deleteNote(gone.id)
    const before = (await db.notes.get(gone.id))!
    await db.notes.update(gone.id, { dirty: false })
    await tick()

    await deleteClassCascade(discrete.id)

    // Re-stamping it would push a row the server already has, and would move
    // a deletion date that means something.
    expect(await db.notes.get(gone.id)).toMatchObject({
      deletedAt: before.deletedAt,
      updatedAt: before.updatedAt,
      dirty: false,
    })
  })

  it('deletes a class with no notebooks at all', async () => {
    const created = await createClass({ name: 'Zoológia' })
    await db.notebooks.clear()

    await deleteClassCascade(created.id)

    expect(await getClass(created.id)).toBeUndefined()
  })
})
