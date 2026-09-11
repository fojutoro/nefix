import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createNote,
  deleteNote,
  listNotes,
  updateNote,
} from '../../db/notes.ts'
import { db, type Notebook } from '../../db/schema.ts'
import { scopeOf } from '../classes/selection.ts'
import { searchNotes } from './search.ts'

// updatedAt is compared as a string, so a note written in the same
// millisecond as another is indistinguishable from it.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

const titles = (notes: { title: string }[]) => notes.map((note) => note.title)

beforeEach(async () => {
  await db.notes.clear()
})

describe('searchNotes', () => {
  it('finds a diacritic title from an unaccented query', async () => {
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# množiny' })

    expect(titles(await searchNotes('diskretna'))).toEqual([
      'Diskrétna matematika',
    ])
  })

  it('finds an unaccented title from a diacritic query', async () => {
    await createNote({ title: 'diskretna matematika' })

    expect(titles(await searchNotes('Diskrétna'))).toEqual([
      'diskretna matematika',
    ])
  })

  it('matches the body as well as the title', async () => {
    await createNote({ title: 'Prednáška 3', bodyMd: 'dôkaz indukciou' })

    expect(titles(await searchNotes('dokaz'))).toEqual(['Prednáška 3'])
  })

  it('requires every term, not any of them', async () => {
    await createNote({ title: 'Diskrétna matematika' })
    await tick()
    await createNote({ title: 'Diskrétna logika' })

    expect(titles(await searchNotes('diskretna matematika'))).toEqual([
      'Diskrétna matematika',
    ])
    expect(titles(await searchNotes('diskretna'))).toEqual([
      'Diskrétna logika',
      'Diskrétna matematika',
    ])
  })

  it('returns every note for an empty query, in listNotes order', async () => {
    await createNote({ title: 'prvá' })
    await tick()
    await createNote({ title: 'druhá' })

    const expected = (await listNotes()).map((note) => note.id)
    expect((await searchNotes('')).map((note) => note.id)).toEqual(expected)
    expect((await searchNotes('   ')).map((note) => note.id)).toEqual(expected)
  })

  it('never returns a deleted note', async () => {
    const note = await createNote({ title: 'Diskrétna matematika' })
    await deleteNote(note.id)

    expect(await searchNotes('diskretna')).toEqual([])
    expect(titles(await searchNotes(''))).toEqual([])
  })

  it('ranks a title match above a body match, newest first within each', async () => {
    await createNote({ title: 'Algebra', bodyMd: 'úvod do teórie grafov' })
    await tick()
    await createNote({ title: 'Teória grafov' })
    await tick()
    await createNote({ title: 'Analýza', bodyMd: 'kreslenie grafov' })

    // Analýza is the most recently written, and still sorts below the note
    // whose title matches.
    expect(titles(await searchNotes('grafov'))).toEqual([
      'Teória grafov',
      'Analýza',
      'Algebra',
    ])
  })

  it('keeps searchText current when the body is edited', async () => {
    const note = await createNote({ title: 'Poznámka' })
    expect(await searchNotes('spojitost')).toEqual([])

    await updateNote(note.id, { bodyMd: 'spojitosť funkcie' })

    expect(titles(await searchNotes('spojitost'))).toEqual(['Poznámka'])
  })
})

describe('searchNotes within a scope', () => {
  it('searches only the notes the scope admits', async () => {
    await createNote({ title: 'Množiny', notebookId: 'discrete' })
    await tick()
    await createNote({ title: 'Množiny cvičenie', notebookId: 'algebra' })

    const inDiscrete = await searchNotes(
      'mnoziny',
      (note) => note.notebookId === 'discrete',
    )

    expect(titles(inDiscrete)).toEqual(['Množiny'])
  })

  it('applies the scope to an empty query too', async () => {
    await createNote({ title: 'Množiny', notebookId: 'discrete' })
    await createNote({ title: 'Vektory', notebookId: null })

    expect(titles(await searchNotes('', (note) => note.notebookId === null))).toEqual([
      'Vektory',
    ])
  })
})

// A page is a note with an order, and it lives in a notebook that belongs to
// a class. Without a guard in scopeOf it therefore turns up in the class's
// table of contents, in Today and in any search — three lists where a page
// torn out of its book is actively wrong. The four tests below are the same
// predicate through its three call sites, because they share the predicate
// and nothing else.
describe('scopeOf keeps pages out of the note lists', () => {
  const book = { id: 'book', classId: 'c1', kind: 'collegebook' } as Notebook
  const plain = { id: 'plain', classId: 'c1', kind: 'notes' } as Notebook

  const seed = async () => {
    await createNote({ title: 'Loose note', notebookId: plain.id })
    await tick()
    await createNote({ title: 'Page one', notebookId: book.id, pageOrder: 1 })
  }

  it('leaves them out of the class contents', async () => {
    await seed()

    const scope = scopeOf({ kind: 'class', classId: 'c1' }, [book, plain])
    expect(titles(await searchNotes('', scope))).toEqual(['Loose note'])
  })

  it('leaves them out of Today', async () => {
    await seed()

    const scope = scopeOf({ kind: 'today' }, [book, plain])
    expect(titles(await searchNotes('', scope))).toEqual(['Loose note'])
  })

  it('leaves them out of Unfiled', async () => {
    await createNote({ title: 'Unfiled note' })
    await tick()
    // A page whose book has no class is still a page, and Unfiled is the one
    // list a null notebookId would otherwise put it in.
    await createNote({ title: 'Orphan page', pageOrder: 1 })

    const scope = scopeOf({ kind: 'unfiled' }, [])
    expect(titles(await searchNotes('', scope))).toEqual(['Unfiled note'])
  })

  it('leaves them out of a search', async () => {
    await createNote({
      title: 'Množiny',
      bodyMd: 'relácie',
      notebookId: plain.id,
    })
    await tick()
    await createNote({
      title: 'Množiny',
      bodyMd: 'relácie',
      notebookId: book.id,
      pageOrder: 1,
    })

    const scope = scopeOf({ kind: 'class', classId: 'c1' }, [book, plain])
    expect(await searchNotes('mnoziny', scope)).toHaveLength(1)
  })
})
