import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createNote, deleteNote, updateNote } from './db/notes.ts'
import type { Note } from './db/schema.ts'
import Editor from './features/notes/Editor.tsx'
import NoteList from './features/notes/NoteList.tsx'
import { searchNotes } from './features/notes/search.ts'
import { useAutosave } from './features/notes/useAutosave.ts'

export default function App() {
  const { t, i18n } = useTranslation()
  // null until the first read finishes, so the empty state is not shown to
  // someone who simply has a slow disk.
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [online, setOnline] = useState(() => navigator.onLine)

  const refresh = useCallback(() => searchNotes(query).then(setNotes), [query])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    // navigator.onLine only reports whether an interface is up, so it can
    // claim online on a network that reaches nothing. It is still what the
    // events report, and this indicator promises nothing more than that.
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const save = useCallback(
    async (id: string, patch: { bodyMd: string; title: string }) => {
      await updateNote(id, patch)
      await refresh()
    },
    [refresh],
  )

  const onChange = useAutosave(selectedId, t('notes.untitled'), save)

  const create = async () => {
    const note = await createNote({})
    await refresh()
    setSelectedId(note.id)
  }

  const remove = async (id: string) => {
    await deleteNote(id)
    if (id === selectedId) setSelectedId(null)
    await refresh()
  }

  const selected = notes?.find((note) => note.id === selectedId) ?? null

  let pane = null
  if (selected !== null) {
    pane = (
      <Editor
        noteId={selected.id}
        initialBody={selected.bodyMd}
        label={t('notes.editorLabel')}
        onChange={onChange}
      />
    )
  } else if (notes !== null) {
    // With a query running, an empty list means nothing matched, which the
    // list says for itself. "No notes yet" would be a lie.
    pane = (
      <p className="empty">
        {notes.length === 0 && query.trim() === ''
          ? t('notes.emptyAll')
          : t('notes.emptyNone')}
      </p>
    )
  }

  return (
    <div className="app">
      <div className="side">
        <NoteList
          notes={notes ?? []}
          query={query}
          onQueryChange={setQuery}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={() => void create()}
          onDelete={(id) => void remove(id)}
        />
        {!online && (
          <p className="offline" role="status">
            {t('app.offline')}
          </p>
        )}
        <button
          type="button"
          className="language"
          onClick={() =>
            void i18n.changeLanguage(i18n.language === 'sk' ? 'en' : 'sk')
          }
        >
          {t('app.switchLanguage')}
        </button>
      </div>
      <main className="pane">{pane}</main>
    </div>
  )
}
