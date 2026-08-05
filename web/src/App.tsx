import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createNote, deleteNote, updateNote } from './db/notes.ts'
import type { Note } from './db/schema.ts'
import Editor from './features/notes/Editor.tsx'
import NoteList from './features/notes/NoteList.tsx'
import { searchNotes } from './features/notes/search.ts'
import { useAutosave } from './features/notes/useAutosave.ts'
import { pushDirtyNotes } from './sync/push.ts'
import { useSyncState } from './sync/state.ts'

// Coarse on purpose: the line re-renders when a sync ends, not on a timer, so
// a minute is the finest unit it can keep honest.
function relative(at: number, language: string): string {
  const seconds = Math.round((at - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (seconds > -60) return format.format(seconds, 'second')
  if (seconds > -3600) return format.format(Math.round(seconds / 60), 'minute')
  return format.format(Math.round(seconds / 3600), 'hour')
}

export default function App() {
  const { t, i18n } = useTranslation()
  // null until the first read finishes, so the empty state is not shown to
  // someone who simply has a slow disk.
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [online, setOnline] = useState(() => navigator.onLine)
  const sync = useSyncState()

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

  // The queue drains on a timer, never on input: pushing per keystroke would
  // send a note once per character and conflict it against itself.
  useEffect(() => {
    const drain = () => void pushDirtyNotes()
    drain()
    const timer = setInterval(() => {
      if (navigator.onLine) drain()
    }, 30_000)
    // Hidden, not unloaded. Mobile Safari can kill a backgrounded tab without
    // ever firing beforeunload, which is the same reason useAutosave listens
    // here.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') drain()
    }
    window.addEventListener('online', drain)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', drain)
      document.removeEventListener('visibilitychange', onHidden)
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

  // navigator.onLine leads, because it reports the loss before a request has
  // to fail to discover it.
  let syncLine
  if (!online || sync.status === 'offline') syncLine = t('sync.offline')
  else if (sync.status === 'syncing') syncLine = t('sync.syncing')
  else if (sync.status === 'unauthenticated') syncLine = t('sync.signIn')
  else if (sync.status === 'error') syncLine = t('sync.error')
  else if (sync.lastSyncedAt === null) syncLine = t('sync.never')
  else {
    syncLine = t('sync.lastSynced', {
      when: relative(sync.lastSyncedAt, i18n.language),
    })
  }

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
        <p className="offline" role="status">
          {syncLine}
        </p>
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
