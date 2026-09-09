import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createNote, deleteNote, updateNote } from './db/notes.ts'
import type { Note } from './db/schema.ts'
import Editor from './features/notes/Editor.tsx'
import NoteList from './features/notes/NoteList.tsx'
import { searchNotes } from './features/notes/search.ts'
import { useAutosave } from './features/notes/useAutosave.ts'
import { sync as runSync } from './sync/index.ts'
import { useSyncState } from './sync/state.ts'

// Ten seconds is short enough that a second window catches up before anyone
// wonders whether it will, and the cycle is one request when nothing changed.
const INTERVAL_MS = 10_000

// `focus` and `visibilitychange` both fire on a window switch, and the
// interval can land on top of them. sync()'s guard stops two runs overlapping
// but not the second pointless round trip.
const DEBOUNCE_MS = 2_000

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

  // Held in a ref so the sync effect below keeps stable dependencies. Reading
  // `refresh` directly would restart the sync timer on every keystroke in the
  // search box.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

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

  // The cycle runs on a timer and on the events that mean the user is looking
  // at this window again, never on input: syncing per keystroke would send a
  // note once per character and conflict it against itself.
  useEffect(() => {
    let last = 0
    let timer: ReturnType<typeof setInterval> | undefined

    const drain = () => {
      const now = Date.now()
      if (now - last < DEBOUNCE_MS) return
      last = now
      void runSync().then((summary) => {
        // A pull that lands notes the list never shows is, to the user, a
        // pull that did not happen.
        if (summary.changed) return refreshRef.current()
      })
    }

    const stop = () => clearInterval(timer)
    const start = () => {
      timer = setInterval(() => {
        if (navigator.onLine) drain()
      }, INTERVAL_MS)
    }

    const onVisibility = () => {
      stop()
      // A hidden tab polling every ten seconds is wasted battery on a phone,
      // and the browser throttles its timers anyway, so the interval exists
      // only while the tab is visible. Becoming visible is what lets a second
      // window catch up at once instead of waiting out a throttled interval;
      // becoming hidden flushes, because mobile Safari can kill a
      // backgrounded tab without ever firing beforeunload.
      if (document.visibilityState === 'visible') start()
      drain()
    }

    drain()
    if (document.visibilityState === 'visible') start()
    window.addEventListener('online', drain)
    window.addEventListener('focus', drain)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      window.removeEventListener('online', drain)
      window.removeEventListener('focus', drain)
      document.removeEventListener('visibilitychange', onVisibility)
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
