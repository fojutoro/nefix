import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClass } from './classes.ts'
import {
  createCollegebook,
  createNotebook,
  listCollegebooks,
  listNotebooksOfKind,
} from './notebooks.ts'
import { createNote, createPage, insertPageAfter, listPages } from './notes.ts'
import { db } from './schema.ts'

beforeEach(async () => {
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
})

const orders = async (notebookId: string) =>
  (await listPages(notebookId)).map((page) => page.pageOrder)

describe('createCollegebook', () => {
  it('creates the book and its first page, both dirty', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    const book = await createCollegebook('Prednášky', created.id)

    expect(book).toMatchObject({
      name: 'Prednášky',
      classId: created.id,
      kind: 'collegebook',
      isGeneral: false,
      deletedAt: null,
      version: 0,
      dirty: true,
      syncedAt: null,
    })

    // A book with no pages is a book you cannot write in.
    const pages = await listPages(book.id)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({
      notebookId: book.id,
      pageOrder: 1,
      dirty: true,
      deletedAt: null,
    })
  })

  it('leaves neither behind when the page cannot be written', async () => {
    // Fails after the notebook is added and while the page is being written,
    // which is the only window where half a collegebook could survive.
    const broken = vi
      .spyOn(db.notes, 'add')
      .mockRejectedValueOnce(new Error('disk full'))

    await expect(createCollegebook('Prednášky', null)).rejects.toThrow(
      'disk full',
    )

    expect(await db.notebooks.count()).toBe(0)
    expect(await db.notes.count()).toBe(0)
    broken.mockRestore()
  })
})

describe('listCollegebooks', () => {
  it('separates the two kinds of notebook', async () => {
    const created = await createClass({ name: 'Diskrétna matematika' })
    const book = await createCollegebook('Prednášky', created.id)
    const plain = await createNotebook('Cvičenia', created.id)

    expect((await listCollegebooks(created.id)).map((row) => row.id)).toEqual([
      book.id,
    ])
    // The general notebook the class was created with, plus the plain one.
    const notes = await listNotebooksOfKind('notes', created.id)
    expect(notes.map((row) => row.id)).toContain(plain.id)
    expect(notes.map((row) => row.id)).not.toContain(book.id)
  })
})

describe('createPage', () => {
  it('appends past the current maximum', async () => {
    const book = await createCollegebook('Prednášky', null)
    await createPage(book.id)
    await createPage(book.id)

    expect(await orders(book.id)).toEqual([1, 2, 3])
  })

  it('counts from the highest order and not from how many pages there are', async () => {
    const book = await createCollegebook('Prednášky', null)
    const second = await createPage(book.id)
    await createPage(book.id)
    // Orders are 1, 2, 3, and deleting the middle one leaves 1 and 3. A
    // createPage that counted the rows would hand out 3 and land a new page
    // exactly on top of an existing one; one that reads the highest order
    // hands out 4.
    await db.notes.delete(second.id)

    const appended = await createPage(book.id)
    expect(appended.pageOrder).toBe(4)
  })
})

describe('insertPageAfter', () => {
  it('takes the midpoint and renumbers nothing', async () => {
    const book = await createCollegebook('Prednášky', null)
    const second = await createPage(book.id)
    const third = await createPage(book.id)

    const inserted = await insertPageAfter(second.id)

    expect(inserted.pageOrder).toBe(2.5)
    expect(await orders(book.id)).toEqual([1, 2, 2.5, 3])
    // The whole reason the column is a float: the neighbours do not move.
    expect((await db.notes.get(second.id))?.pageOrder).toBe(2)
    expect((await db.notes.get(third.id))?.pageOrder).toBe(3)
  })

  it('appends when the page is the last one', async () => {
    const book = await createCollegebook('Prednášky', null)
    const pages = await listPages(book.id)

    const inserted = await insertPageAfter(pages[0]!.id)

    expect(inserted.pageOrder).toBe(2)
  })

  it('survives being used repeatedly in the same gap', async () => {
    const book = await createCollegebook('Prednášky', null)
    await createPage(book.id)
    const first = (await listPages(book.id))[0]!

    await insertPageAfter(first.id)
    await insertPageAfter(first.id)
    await insertPageAfter(first.id)

    expect(await orders(book.id)).toEqual([1, 1.125, 1.25, 1.5, 2])
  })
})

describe('listPages', () => {
  it('orders by pageOrder and not by when the page was written', async () => {
    const book = await createCollegebook('Prednášky', null)
    const first = (await listPages(book.id))[0]!
    const last = await createPage(book.id)
    // Written third, but it belongs between the two: insertion order and
    // sort order disagree from here on, which is what makes this a test.
    const middle = await insertPageAfter(first.id)

    expect((await listPages(book.id)).map((page) => page.id)).toEqual([
      first.id,
      middle.id,
      last.id,
    ])
  })

  it('leaves out deleted pages and other notebooks', async () => {
    const book = await createCollegebook('Prednášky', null)
    const other = await createCollegebook('Cvičenia', null)
    const gone = await createPage(book.id)
    await db.notes.update(gone.id, { deletedAt: new Date().toISOString() })
    // A loose note in the same book is not a page, and must not be listed
    // as one.
    await createNote({ notebookId: book.id })

    expect(await listPages(book.id)).toHaveLength(1)
    expect(await listPages(other.id)).toHaveLength(1)
  })
})
