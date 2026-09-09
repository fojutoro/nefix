import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createClass } from './classes.ts'
import {
  createNotebook,
  deleteNotebook,
  getNotebook,
  listNotebooks,
  updateNotebook,
} from './notebooks.ts'
import { createNote, listNotes } from './notes.ts'
import { db } from './schema.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

beforeEach(async () => {
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
})

describe('createNotebook', () => {
  it('defaults to no class and to not being general', async () => {
    const notebook = await createNotebook('Cvičenia')

    expect(notebook).toMatchObject({
      name: 'Cvičenia',
      classId: null,
      isGeneral: false,
      deletedAt: null,
      version: 0,
      dirty: true,
      syncedAt: null,
    })
    expect(await getNotebook(notebook.id)).toEqual(notebook)
  })

  it('takes a class', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })

    const notebook = await createNotebook('Cvičenia', created.id)

    expect(notebook.classId).toBe(created.id)
  })
})

describe('listNotebooks', () => {
  it('filters by class and excludes deleted notebooks', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    const general = (await db.notebooks.toArray())[0]!
    const seminars = await createNotebook('Cvičenia', created.id)
    const loose = await createNotebook('Nezaradené')
    const gone = await createNotebook('Zmazaný', created.id)
    await deleteNotebook(gone.id)

    const ofClass = await listNotebooks(created.id)
    expect(ofClass.map((n) => n.id).sort()).toEqual(
      [general.id, seminars.id].sort(),
    )

    const all = await listNotebooks()
    expect(all).toHaveLength(3)
    expect(all.map((n) => n.id)).toContain(loose.id)
  })
})

describe('updateNotebook', () => {
  it('renames a general notebook', async () => {
    await createClass({ name: 'Diskrétna matematika' })
    const general = (await db.notebooks.toArray())[0]!
    await db.notebooks.update(general.id, { dirty: false })
    await tick()

    // Renameable but not deletable: the rename half of that rule.
    await updateNotebook(general.id, { name: 'Prednášky' })

    const renamed = await getNotebook(general.id)
    expect(renamed?.name).toBe('Prednášky')
    expect(renamed?.isGeneral).toBe(true)
    expect(renamed?.dirty).toBe(true)
    expect(renamed!.updatedAt > general.updatedAt).toBe(true)
  })
})

describe('deleteNotebook', () => {
  it('refuses a general notebook', async () => {
    await createClass({ name: 'Diskrétna matematika' })
    const general = (await db.notebooks.toArray())[0]!

    await expect(deleteNotebook(general.id)).rejects.toThrow()

    // The rule lives with the data, so the row is still there after the UI
    // has been bypassed entirely.
    expect(await getNotebook(general.id)).toBeDefined()
    expect((await db.notebooks.get(general.id))?.deletedAt).toBeNull()
  })

  it('unfiles its notes rather than deleting them', async () => {
    const notebook = await createNotebook('Cvičenia')
    const kept = await createNote({
      title: 'Množiny',
      bodyMd: '# Množiny',
      notebookId: notebook.id,
    })
    const elsewhere = await createNotebook('Prednášky')
    const untouched = await createNote({
      title: 'Relácie',
      notebookId: elsewhere.id,
    })
    await db.notes.update(kept.id, { dirty: false })
    await tick()

    await deleteNotebook(notebook.id)

    expect(await getNotebook(notebook.id)).toBeUndefined()
    // Losing notes because their container went away is not a tradeoff
    // worth making, so the note survives with its body.
    const orphan = await db.notes.get(kept.id)
    expect(orphan).toMatchObject({
      title: 'Množiny',
      bodyMd: '# Množiny',
      notebookId: null,
      deletedAt: null,
      dirty: true,
    })
    expect(orphan!.updatedAt > kept.updatedAt).toBe(true)
    expect((await listNotes(null)).map((n) => n.id)).toEqual([kept.id])
    // A note in another notebook is not swept up by the same pass.
    expect((await db.notes.get(untouched.id))?.notebookId).toBe(elsewhere.id)
  })

  it('throws on a missing id', async () => {
    await expect(deleteNotebook('nope')).rejects.toThrow()
  })
})
