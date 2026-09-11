import type { Note, Notebook } from '../../db/schema.ts'

// Today and Unfiled are pseudo-classes and behave like one on every screen,
// so the whole rail is a single union rather than a class id plus two flags.
export type Selection =
  | { kind: 'today' }
  | { kind: 'unfiled' }
  | { kind: 'class'; classId: string }

export const TODAY: Selection = { kind: 'today' }

// Comparable, because a selection is compared far more often than it is read
// apart, and two object literals never match.
export const keyOf = (selection: Selection): string =>
  selection.kind === 'class' ? `class:${selection.classId}` : selection.kind

// Local midnight and not UTC: today is the day the person is having.
const midnight = (): string => {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start.toISOString()
}

// The predicate searchNotes filters with. A class arrives as its notebooks
// because membership is notebookId, and a predicate rather than a set of ids
// is what lets Today, which is a time range and not a membership, be the same
// kind of answer as the other two.
export function scopeOf(
  selection: Selection,
  notebooks: Notebook[],
): (note: Note) => boolean {
  const within = shelfOf(selection, notebooks)
  // A page is a note in a notebook that belongs to a class, so without this
  // it appears in the class's contents, in Today and in every search — three
  // lists where a page torn out of its book is wrong. The guard sits here
  // because those three lists share this predicate and nothing else. A
  // collegebook is read as a book, from its own screen.
  return (note) => note.pageOrder === null && within(note)
}

function shelfOf(
  selection: Selection,
  notebooks: Notebook[],
): (note: Note) => boolean {
  if (selection.kind === 'unfiled') return (note) => note.notebookId === null
  if (selection.kind === 'today') {
    const since = midnight()
    return (note) => note.updatedAt >= since
  }
  const ids = new Set(
    notebooks
      .filter((row) => row.classId === selection.classId)
      .map((row) => row.id),
  )
  return (note) => note.notebookId !== null && ids.has(note.notebookId)
}

// Where a new note goes, which is a decision the user never makes: a class
// means its general notebook, and null means unfiled, which is a real answer
// rather than a failure to find one.
export function generalNotebookOf(
  classId: string | null,
  notebooks: Notebook[],
): string | null {
  if (classId === null) return null
  const general = notebooks.find(
    (row) => row.classId === classId && row.isGeneral,
  )
  return general?.id ?? null
}
