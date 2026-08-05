import { normalize } from '../../db/normalize.ts'
import { db, type Note } from '../../db/schema.ts'

// Substring matching over the text normalised at write time. No stemming,
// no fuzzy matching and no relevance scoring beyond title-before-body:
// substrings are enough for one person's notes, and they are predictable,
// which matters more.
export async function searchNotes(query: string): Promise<Note[]> {
  const terms = normalize(query).split(' ').filter((term) => term !== '')

  const matches = await db.notes
    .orderBy('updatedAt')
    .reverse()
    .filter(
      (note) =>
        note.deletedAt === null &&
        terms.every((term) => note.searchText.includes(term)),
    )
    .toArray()

  // An empty query is every note, in listNotes order.
  if (terms.length === 0) return matches

  // Normalising here rather than storing the title separately: only the
  // rows that already matched are touched, and a title is at most 200
  // characters. The index order is updatedAt descending, so partitioning
  // preserves it inside each group.
  const titleMatches = (note: Note) => {
    const title = normalize(note.title)
    return terms.every((term) => title.includes(term))
  }
  return [...matches.filter(titleMatches), ...matches.filter((note) => !titleMatches(note))]
}
