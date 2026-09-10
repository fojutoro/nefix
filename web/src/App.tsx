import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  archiveClass,
  countNotesInClass,
  createClass,
  deleteClassCascade,
  listArchivedClasses,
  listClasses,
  readLastClassId,
  readLastWrittenClassId,
  updateClass,
  writeLastClassId,
  writeLastWrittenClassId,
  type ClassWithRecency,
} from './db/classes.ts'
import { listNotebooks } from './db/notebooks.ts'
import {
  RAIL_DEFAULT,
  readRailWidth,
  writeRailWidth,
} from './db/prefs.ts'
import {
  clearEverything,
  countDirtyRows,
  countNotes,
  countUnfiledNotes,
  createNote,
  deleteNote,
  readLastNoteId,
  updateNote,
  writeLastNoteId,
} from './db/notes.ts'
import type { Class, Note, Notebook } from './db/schema.ts'
import AuthScreen from './features/auth/AuthScreen.tsx'
import ClassPage from './features/classes/ClassPage.tsx'
import ClassRail from './features/classes/ClassRail.tsx'
import RailHandle from './features/classes/RailHandle.tsx'
import {
  generalNotebookOf,
  keyOf,
  scopeOf,
  TODAY,
  type Selection,
} from './features/classes/selection.ts'
import Editor from './features/notes/Editor.tsx'
import { searchNotes } from './features/notes/search.ts'
import { useAutosave } from './features/notes/useAutosave.ts'
import { logout, me } from './sync/auth.ts'
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

// Guarded, because autosave fires twice a second while someone is typing and
// this value changes only when they move to another class. At module scope
// because the ref is the whole of its state.
function remember(
  written: { current: string | null },
  classId: string | null,
): void {
  if (classId === null || classId === written.current) return
  written.current = classId
  void writeLastWrittenClassId(classId)
}

// Whether anything has been on screen yet. Not a ref, because a ref may not
// be read while rendering, and not state, because setting it would be a
// second render for a value that only picks a CSS class. It exists so the
// crossfade has something to fade out of: nothing animates on load.
let painted = false

function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const { t, i18n } = useTranslation()
  // null until the first read finishes, so the empty state is not shown to
  // someone who simply has a slow disk.
  const [notes, setNotes] = useState<Note[] | null>(null)
  // The shelf without the search applied. The strip is the class, not the
  // query, and it must not change shape while somebody types.
  const [all, setAll] = useState<Note[]>([])
  const [classes, setClasses] = useState<ClassWithRecency[] | null>(null)
  const [archived, setArchived] = useState<Class[]>([])
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [unfiled, setUnfiled] = useState(0)
  const [chosen, setChosen] = useState<Selection>(TODAY)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT)
  // True for a note that was just created and false for one that was merely
  // opened: `n` has to land the cursor in the note, and a click on a row
  // must not pull focus off the row that was clicked.
  const [focusEditor, setFocusEditor] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const sync = useSyncState()

  const selected = notes?.find((note) => note.id === selectedId) ?? null

  // A class can leave while it is on screen: a pull can deliver its deletion
  // from another device. Answered here rather than corrected in an effect, so
  // a class that is not there reads as Today for the whole of one render.
  // Unloaded classes are taken on trust, or a restored selection would flash
  // Today on the way in.
  const reachable =
    chosen.kind !== 'class' ||
    classes === null ||
    [...classes, ...archived].some((row) => row.id === chosen.classId)
  const selection = reachable ? chosen : TODAY

  // Nothing is remembered until the stored ids have been read back, so the
  // mount-time write of `null` cannot erase them before the read returns.
  const restored = useRef(false)

  useEffect(() => {
    void Promise.all([
      readLastNoteId(),
      readLastClassId(),
      readRailWidth(),
    ]).then(([noteId, classId, width]) => {
      restored.current = true
      setRailWidth(width)
        // Only if nothing has been picked meanwhile: a restore has no
        // business pulling the user off a note they just opened.
      setSelectedId((current) => current ?? noteId)
      // Both reads validate what they hand back, so a deleted or archived
      // class arrives as null, and null is Today.
      if (classId !== null) {
        setChosen((current) =>
          current.kind === 'today' ? { kind: 'class', classId } : current,
        )
      }
    })
  }, [])

  useEffect(() => {
    if (restored.current) void writeLastNoteId(selectedId)
  }, [selectedId])

  useEffect(() => {
    if (!restored.current) return
    void writeLastClassId(
      selection.kind === 'class' ? selection.classId : null,
    )
  }, [selection])

  // Which notes the middle pane is a list of. Rebuilt from the notebooks
  // rather than filtered by class id, because membership is notebookId.
  const scope = useMemo(
    () => scopeOf(selection, notebooks),
    [selection, notebooks],
  )
  const refresh = useCallback(
    () =>
      searchNotes(query, scope).then((found) => {
        setNotes(found)
        // Only while a search is running is a second read needed: with no
        // query the cards already are the whole shelf.
        if (query.trim() === '') return setAll(found)
        return searchNotes('', scope).then(setAll)
      }),
    [query, scope],
  )

  // Held in a ref so the sync effect below keeps stable dependencies. Reading
  // `refresh` directly would restart the sync timer on every keystroke in the
  // search box.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  // The last class written in, guarded against a write per autosave.
  const written = useRef<string | null>(null)

  // The rail's own read. Separate from the note list's, because a keystroke
  // in the search box changes the list and nothing about the rail.
  const refreshRail = useCallback(
    () =>
      Promise.all([
        listClasses(),
        listArchivedClasses(),
        listNotebooks(),
        countUnfiledNotes(),
      ]).then(([active, gone, books, unfiledCount]) => {
        setClasses(active)
        setArchived(gone)
        setNotebooks(books)
        setUnfiled(unfiledCount)
      }),
    [],
  )

  const classOfNotebook = useMemo(
    () => new Map(notebooks.map((row) => [row.id, row.classId])),
    [notebooks],
  )
  const classOf = (notebookId: string | null) =>
    notebookId === null ? null : classOfNotebook.get(notebookId) ?? null

  // Read by save, which is handed an id and a patch and not the row, so the
  // class it belongs to has to be carried forward from the render.
  const writingIn = useRef<string | null>(null)
  useEffect(() => {
    writingIn.current = selected === null ? null : classOf(selected.notebookId)
  })

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refreshRail()
  }, [refreshRail])

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
      remember(written, writingIn.current)
      await Promise.all([refresh(), refreshRail()])
    },
    [refresh, refreshRail],
  )

  const onChange = useAutosave(selectedId, t('notes.untitled'), save)

  const create = async () => {
    // A selected class means its general notebook, which the user never chose
    // and never sees. Today and Unfiled are not places to write, so the note
    // goes where the last one went, and with nothing written yet it is
    // unfiled, which is a note and not a prompt to set up a class first.
    const classId =
      selection.kind === 'class'
        ? selection.classId
        : await readLastWrittenClassId()
    // From the database rather than from the loaded rail: `n` answers on the
    // first keystroke after a cold load, which can be before the read lands.
    const notebookId =
      classId === null
        ? null
        : generalNotebookOf(classId, await listNotebooks(classId))
    const note = await createNote({ notebookId })
    remember(written, classId)
    // A note you cannot see is not a note you can type in, so when it lands
    // on a shelf other than the one on screen, the screen follows the note.
    if (!scope(note)) {
      setChosen(
        classId === null ? { kind: 'unfiled' } : { kind: 'class', classId },
      )
    }
    setFocusEditor(true)
    await Promise.all([refresh(), refreshRail()])
    setSelectedId(note.id)
  }

  // Every one of these is a no-op unless a class is on screen, which is the
  // only state the controls exist in.
  const editClass = async (patch: {
    name?: string
    code?: string | null
    colour?: string | null
    semester?: string | null
  }) => {
    if (selection.kind !== 'class') return
    await updateClass(selection.classId, patch)
    await refreshRail()
  }

  const archive = async () => {
    if (selection.kind !== 'class' || shelf === null) return
    if (!window.confirm(t('class.archiveConfirm', { name: shelf.name }))) return
    await archiveClass(selection.classId)
    // Its notes are untouched and reachable under Archived.
    setChosen(TODAY)
    await refreshRail()
  }

  const destroy = async () => {
    if (selection.kind !== 'class' || shelf === null) return
    // Counted here rather than taken from the cards on screen: a pull, another
    // window, or a note written since the page loaded all make that number
    // stale, and a stale number in a destructive dialog is one that lied to
    // get the answer it wanted.
    const count = await countNotesInClass(selection.classId)
    const question =
      count === 0
        ? t('class.deleteConfirmEmpty', { name: shelf.name })
        : t('class.deleteConfirm', { name: shelf.name, count })
    if (!window.confirm(question)) return
    await deleteClassCascade(selection.classId)
    setChosen(TODAY)
    await Promise.all([refresh(), refreshRail()])
  }

  const addClass = async (name: string) => {
    const created = await createClass({ name })
    // Before the selection, because the fallback above reads the loaded rail
    // to decide whether a selected class exists, and a class it has not seen
    // yet is one it would send back to Today.
    await refreshRail()
    setCreating(false)
    setRailOpen(false)
    setChosen({ kind: 'class', classId: created.id })
  }

  const remove = async (id: string) => {
    await deleteNote(id)
    if (id === selectedId) setSelectedId(null)
    await Promise.all([refresh(), refreshRail()])
  }

  // Held in a ref so the shortcut is registered once. Reading `create`
  // directly would add and remove a window listener on every keystroke in the
  // search box.
  const leave = () => {
    setFocusEditor(false)
    setSelectedId(null)
  }

  const latest = useRef({ create, leave, inEditor: selected !== null })
  useEffect(() => {
    latest.current = { create, leave, inEditor: selected !== null }
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The editor first. With a note open that is what Escape is for, and
        // the drawer is not what the user is looking at.
        if (latest.current.inEditor) latest.current.leave()
        else setRailOpen(false)
        return
      }
      // Cmd-N and Ctrl-N belong to the browser.
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      // CodeMirror's document is contenteditable, so isContentEditable is
      // what catches the editor; an input is not contentEditable, which is
      // why the tag names are asked for as well. Getting this wrong means
      // typing the letter n in a note creates a note.
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest('input, textarea, select, [contenteditable]') !== null)
      ) {
        return
      }
      event.preventDefault()
      void latest.current.create()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const signOut = async () => {
    const dirty = await countDirtyRows()
    const question =
      dirty > 0
        ? t('auth.signOutConfirmDirty', { count: dirty })
        : t('auth.signOutConfirm')
    if (!window.confirm(question)) return
    // Cleared whether or not the request reached the server. The confirmation
    // promised that the notes leave this device, and a shared machine with no
    // network is exactly when that promise matters most. Anything the server
    // already has comes back on the next sign-in; anything it does not was
    // named in the confirmation.
    await logout().catch(() => undefined)
    await clearEverything()
    onSignedOut()
  }

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

  const shelf =
    selection.kind === 'class'
      ? [...(classes ?? []), ...archived].find(
          (row) => row.id === selection.classId,
        ) ?? null
      : null
  const heading =
    selection.kind === 'class'
      ? shelf?.name ?? ''
      : t(selection.kind === 'today' ? 'rail.today' : 'rail.unfiled')

  const startFirstClass = () => {
    setRailOpen(true)
    setCreating(true)
  }

  // Below 900px the rail is a drawer, and this is what opens it. It lives in
  // the content pane because that is the only thing on screen while the rail
  // is away; the editor has the back arrow there instead.
  const toggle = (
    <button
      type="button"
      className="rail-toggle"
      aria-expanded={railOpen}
      onClick={() => setRailOpen(!railOpen)}
    >
      {t('rail.label')}
    </button>
  )

  let content = null
  if (selected !== null) {
    content = (
      <div className="note">
        <header className="note-head">
          <button
            type="button"
            className="back"
            aria-label={t('editor.back', { name: heading })}
            onClick={leave}
          >
            <span aria-hidden="true">&larr;</span>
            <span className="meta">{heading}</span>
          </button>
        </header>
        <Editor
          noteId={selected.id}
          initialBody={selected.bodyMd}
          label={t('notes.editorLabel')}
          focus={focusEditor}
          onChange={onChange}
        />
      </div>
    )
  } else if (notes !== null && classes !== null) {
    content = (
      <ClassPage
        kind={selection.kind}
        heading={heading}
        code={shelf?.code ?? null}
        colour={shelf?.colour ?? null}
        semester={shelf?.semester ?? null}
        notes={notes}
        all={all}
        query={query}
        toggle={toggle}
        notice={
          classes.length === 0 && (
            // One sentence and the same affordance as the rail, not a tour.
            <p className="notice">
              {t('classes.empty')}
              <button type="button" onClick={startFirstClass}>
                {t('classes.addFirst')}
              </button>
            </p>
          )
        }
        onQueryChange={setQuery}
        onSelect={(id) => {
          setFocusEditor(false)
          setSelectedId(id)
        }}
        onCreate={() => void create()}
        onDelete={(id) => void remove(id)}
        // An empty name does nothing: a class has to be called something.
        onRename={(name) => name !== '' && void editClass({ name })}
        onCode={(code) => void editClass({ code: code === '' ? null : code })}
        onColour={(colour) => void editClass({ colour })}
        onSemester={(semester) =>
          void editClass({ semester: semester === '' ? null : semester })
        }
        onArchive={() => void archive()}
        onDeleteClass={() => void destroy()}
      />
    )
  }

  const fade = painted
  useEffect(() => {
    if (content !== null) painted = true
  })

  return (
    <div
      className="app"
      data-rail-open={railOpen}
      style={{ '--rail': `${railWidth}px` } as CSSProperties}
    >
      <div className="rail">
        <ClassRail
          classes={classes ?? []}
          archived={archived}
          unfiledCount={unfiled}
          selection={selection}
          creating={creating}
          onSelect={(next) => {
            setRailOpen(false)
            // The search belongs to the shelf it was typed on, and the box
            // is rebuilt with the page.
            setQuery('')
            setChosen(next)
          }}
          onCreatingChange={setCreating}
          onCreate={(name) => void addClass(name)}
        />
        {sync.status === 'unauthenticated' && (
          // Offered, never forced: throwing someone back to the login screen
          // mid-sentence would lose nothing from IndexedDB but would feel
          // exactly like it had.
          <p className="banner" role="alert">
            {t('auth.sessionEnded')}
            <button type="button" onClick={onSignedOut}>
              {t('auth.signInAgain')}
            </button>
          </p>
        )}
        <p className="offline" role="status">
          {syncLine}
        </p>
        <div className="side-actions">
          <button
            type="button"
            className="language"
            onClick={() =>
              void i18n.changeLanguage(i18n.language === 'sk' ? 'en' : 'sk')
            }
          >
            {t('app.switchLanguage')}
          </button>
          <button type="button" onClick={() => void signOut()}>
            {t('auth.signOut')}
          </button>
        </div>
      </div>
      <RailHandle
        width={railWidth}
        onResize={setRailWidth}
        onCommit={(width) => void writeRailWidth(width)}
      />
      <main
        className="content"
        key={selected !== null ? `note:${selected.id}` : keyOf(selection)}
        data-fade={fade}
      >
        {content}
      </main>
    </div>
  )
}

// Three outcomes, not two: a user, a 401, or no answer at all.
type Gate = 'checking' | 'in' | 'out'

export default function App() {
  const [gate, setGate] = useState<Gate>('checking')

  useEffect(() => {
    void me()
      .then((user) => setGate(user === null ? 'out' : 'in'))
      .catch(async () => {
        // Not a 401: the request never got an answer. A session cookie plus
        // notes on the device is someone on a train, and a login screen there
        // would contradict the whole offline-first premise. With nothing
        // stored there is nothing to show, so the wall stands.
        setGate((await countNotes()) > 0 ? 'in' : 'out')
      })
  }, [])

  // Blank rather than a login screen: showing the wall for the length of one
  // request and then replacing it would be a flash of the wrong answer.
  if (gate === 'checking') return null
  if (gate === 'out') return <AuthScreen onSignedIn={() => setGate('in')} />
  return <Workspace onSignedOut={() => setGate('out')} />
}
