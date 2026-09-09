import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archiveClass,
  createClass,
  deleteClass,
  getClass,
  listArchivedClasses,
  listClasses,
  unarchiveClass,
  updateClass,
} from './classes.ts'
import { createNote } from './notes.ts'
import { db } from './schema.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

beforeEach(async () => {
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
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

describe('listClasses', () => {
  it('orders by name and excludes archived and deleted classes', async () => {
    const algebra = await createClass({ name: 'Lineárna algebra' })
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const old = await createClass({ name: 'Fyzika' })
    const gone = await createClass({ name: 'Zmazaný' })
    await archiveClass(old.id)
    await deleteClass(gone.id)

    expect((await listClasses()).map((c) => c.id)).toEqual([
      discrete.id,
      algebra.id,
    ])
    expect((await listArchivedClasses()).map((c) => c.id)).toEqual([old.id])
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
