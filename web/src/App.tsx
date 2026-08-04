// Temporary proof page for the local notes store. Replaced by the editor
// in the next step. Components read and write IndexedDB directly; that is
// the rule, not an exception.
import { useEffect, useState } from 'react'
import { createNote, deleteNote, listNotes } from './db/notes.ts'
import type { Note } from './db/schema.ts'

export default function App() {
  const [notes, setNotes] = useState<Note[]>([])

  const refresh = () => void listNotes().then(setNotes)

  useEffect(refresh, [])

  return (
    <main>
      <h1>notes store</h1>
      <button
        type="button"
        onClick={() =>
          void createNote({ title: `note ${notes.length + 1}` }).then(refresh)
        }
      >
        create
      </button>
      <button type="button" onClick={refresh}>
        list
      </button>
      <button
        type="button"
        disabled={notes.length === 0}
        onClick={() => void deleteNote(notes[0]!.id).then(refresh)}
      >
        delete newest
      </button>
      <pre>{JSON.stringify(notes, null, 2)}</pre>
    </main>
  )
}
