import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createNote,
  deleteNote,
  listNotes,
  updateNote,
} from '../../db/notes.ts'
import { db } from '../../db/schema.ts'
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
