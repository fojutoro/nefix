import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  countNotes,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  restoreNote,
  updateNote,
} from './notes.ts'
import { db } from './schema.ts'

// updatedAt is compared as a string, so a note written in the same
// millisecond as another is indistinguishable from it.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

beforeEach(async () => {
  await db.notes.clear()
})

describe('createNote', () => {
  it('round-trips through getNote', async () => {
    const created = await createNote({ title: 'algebra', bodyMd: '# sets' })

    expect(await getNote(created.id)).toEqual(created)
  })

  it('defaults the sync metadata', async () => {
    const note = await createNote({})

    expect(note).toMatchObject({
      title: '',
      bodyMd: '',
      classId: null,
      visibility: 'private',
      deletedAt: null,
      forkedFromId: null,
      version: 0,
      dirty: true,
      syncedAt: null,
    })
    expect(note.createdAt).toBe(note.updatedAt)
  })
})

describe('listNotes', () => {
  it('excludes deleted notes and orders by updatedAt descending', async () => {
    const first = await createNote({ title: 'first' })
    await tick()
    const second = await createNote({ title: 'second' })
    await tick()
    const third = await createNote({ title: 'third' })
    await deleteNote(second.id)

    expect((await listNotes()).map((note) => note.id)).toEqual([
      third.id,
      first.id,
    ])
    expect(await countNotes()).toBe(2)
  })
})

describe('updateNote', () => {
  it('changes the field, bumps updatedAt and sets dirty', async () => {
    const note = await createNote({ title: 'draft' })
    await db.notes.update(note.id, { dirty: false })
    await tick()

    await updateNote(note.id, { title: 'final' })

    const updated = await getNote(note.id)
    expect(updated?.title).toBe('final')
    expect(updated?.bodyMd).toBe('')
    expect(updated?.dirty).toBe(true)
    expect(updated!.updatedAt > note.updatedAt).toBe(true)
  })

  it('throws on a missing id', async () => {
    await expect(updateNote('nope', { title: 'x' })).rejects.toThrow()
  })

  it('throws on a deleted id', async () => {
    const note = await createNote({ title: 'gone' })
    await deleteNote(note.id)

    await expect(updateNote(note.id, { title: 'x' })).rejects.toThrow()
  })
})

describe('deleteNote', () => {
  it('hides the note but keeps the row', async () => {
    const note = await createNote({ title: 'temporary' })
    await db.notes.update(note.id, { dirty: false })
    await tick()

    await deleteNote(note.id)

    expect(await getNote(note.id)).toBeUndefined()
    // Asserted on the raw table: through the API a soft delete and a hard
    // delete look identical, so only this proves the row survives.
    const row = await db.notes.get(note.id)
    expect(row).toBeDefined()
    expect(row?.deletedAt).not.toBeNull()
    expect(row?.dirty).toBe(true)
    expect(row!.updatedAt > note.updatedAt).toBe(true)
  })
})

describe('restoreNote', () => {
  it('brings the note back', async () => {
    const note = await createNote({ title: 'oops' })
    await deleteNote(note.id)
    const afterDelete = (await db.notes.get(note.id))!.updatedAt
    await tick()

    await restoreNote(note.id)

    const restored = await getNote(note.id)
    expect(restored).toMatchObject({
      id: note.id,
      deletedAt: null,
      dirty: true,
    })
    expect(restored!.updatedAt > afterDelete).toBe(true)
    expect(await countNotes()).toBe(1)
  })
})
