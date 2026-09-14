import { liveQuery } from 'dexie'
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { listClasses, type ClassWithRecency } from '../../db/classes.ts'
import { listDeadlines } from '../../db/deadlines.ts'
import { listNotebooks } from '../../db/notebooks.ts'
import { listNotes } from '../../db/notes.ts'
import type { Deadline, Note, Notebook } from '../../db/schema.ts'
import Icon from '../../ui/Icon.tsx'
import { countdown } from '../classes/countdown.ts'
import DeadlineModal from '../classes/DeadlineModal.tsx'
import NewClassForm from '../classes/NewClassForm.tsx'
import { relative, useMinute } from '../notes/relative.ts'

const RECENTS = 4

// Past this the list pushes the rest of the page below the fold, and the
// remainder is counted instead.
const UPCOMING = 8

type Shelf = {
  classes: ClassWithRecency[]
  notebooks: Notebook[]
  notes: Note[]
  deadlines: Deadline[]
}

const EMPTY: Shelf = { classes: [], notebooks: [], notes: [], deadlines: [] }

type Props = {
  toggle: ReactNode
  onOpenNote: (id: string) => void
  onOpenPage: (bookId: string, noteId: string) => void
  onOpenClass: (classId: string) => void
  onCreateClass: (name: string) => void
}

function greeting(now: number): string {
  const hour = new Date(now).getHours()
  if (hour >= 5 && hour < 12) return 'home.morning'
  if (hour >= 12 && hour < 18) return 'home.afternoon'
  return 'home.evening'
}

function Section({
  label,
  action,
  children,
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className="home-section" aria-labelledby={id}>
      <div className="home-section-head">
        <h2 id={id} className="meta">
          {label}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export default function Home({
  toggle,
  onOpenNote,
  onOpenPage,
  onOpenClass,
  onCreateClass,
}: Props) {
  const { t, i18n } = useTranslation()
  const now = useMinute()
  // The rail's formatter, so a class reads "3w ago" in both places.
  const format = useMemo(
    () =>
      new Intl.RelativeTimeFormat(i18n.language, {
        numeric: 'always',
        style: 'narrow',
      }),
    [i18n.language],
  )
  // Null until the first read, so nothing on the page claims to be empty
  // before it has looked.
  const [shelf, setShelf] = useState<Shelf | null>(null)
  const [semester, setSemester] = useState('')
  const [creating, setCreating] = useState(false)
  const [adding, setAdding] = useState(false)

  // Live, because a deadline saved in the modal below and one delivered by a
  // pull both have to appear, and neither write path knows this page exists.
  // One query over all four reads, so a change re-reads them together and the
  // page is never drawn from half of an update.
  useEffect(() => {
    const watch = liveQuery(() =>
      Promise.all([listClasses(), listNotebooks(), listNotes(), listDeadlines()]),
    ).subscribe({
      next: ([classes, notebooks, notes, deadlines]) =>
        setShelf({ classes, notebooks, notes, deadlines }),
      error: () => setShelf(EMPTY),
    })
    return () => watch.unsubscribe()
  }, [])

  const { classes, notebooks, notes, deadlines } = shelf ?? EMPTY
  // Active classes only. A deadline or a note whose class is not in here was
  // put away with an archived semester, and this page does not resurface it.
  const byId = new Map(classes.map((row) => [row.id, row]))
  const books = new Map(notebooks.map((row) => [row.id, row]))

  const semesters = [
    ...new Set(classes.flatMap((row) => (row.semester === null ? [] : [row.semester]))),
  ].sort()
  // A semester that has since left every class filters nothing out.
  const chosen = semesters.includes(semester) ? semester : ''
  const inTerm = (row: ClassWithRecency) =>
    chosen === '' || row.semester === null || row.semester === chosen

  // Soonest first, which puts the overdue ones at the top.
  const outstanding = deadlines.filter((row) => row.doneAt === null)
  const upcoming = outstanding.filter((row) => {
    if (row.classId === null) return true
    const owner = byId.get(row.classId)
    return owner !== undefined && inTerm(owner)
  })

  // A page's number is its position in the book and not its stored order,
  // which is a float that halves every time a page is inserted.
  const numbers = new Map<string, number>()
  const perBook = new Map<string | null, number>()
  const pages = notes.filter((note) => note.pageOrder !== null)
  for (const page of pages.sort((a, b) => a.pageOrder! - b.pageOrder!)) {
    const number = (perBook.get(page.notebookId) ?? 0) + 1
    perBook.set(page.notebookId, number)
    numbers.set(page.id, number)
  }

  // Whether a note is shown at all: loose, or in an active class.
  const visible = (note: Note) => {
    if (note.notebookId === null) return true
    const book = books.get(note.notebookId)
    if (book === undefined) return false
    return book.classId === null || byId.has(book.classId)
  }
  // listNotes is newest first across notes and pages alike.
  const recents = notes.filter(visible).slice(0, RECENTS)

  const place = (classId: string | null) =>
    (classId === null ? undefined : byId.get(classId)?.name) ?? t('home.none')

  return (
    <div className="page home">
      {toggle}
      <header className="home-head">
        <h1>{t(greeting(now))}</h1>
        {semesters.length > 0 && (
          <select
            value={chosen}
            aria-label={t('home.semester')}
            onChange={(event) => setSemester(event.target.value)}
          >
            <option value="">{t('home.allSemesters')}</option>
            {semesters.map((term) => (
              <option key={term} value={term}>
                {term}
              </option>
            ))}
          </select>
        )}
      </header>
      {shelf !== null && (
        <>
          {/* Cards for the classes, which are chosen between; lists below for
              what is scanned. Each card carries its class's own next deadline,
              so urgency sits with the class it concerns. */}
          <Section label={t('home.classes')}>
            <ul className="class-cards">
              {classes.filter(inTerm).map((row) => {
                const next = outstanding.find((deadline) => deadline.classId === row.id)
                const due =
                  next === undefined
                    ? undefined
                    : countdown(next.dueAt, false, now, i18n.language, t)
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="class-card"
                      data-late={due?.late ?? false}
                      style={
                        row.colour === null
                          ? undefined
                          : ({ '--class-colour': row.colour } as CSSProperties)
                      }
                      onClick={() => onOpenClass(row.id)}
                    >
                      <Icon name="graduation-cap" className="class-card-icon" />
                      <span className="class-card-name">{row.name}</span>
                      {/* One answer: the next deadline, or how long since the
                          class was written in, or a dash for a class nobody
                          has written in yet. */}
                      <span className="class-card-slot">
                        {next === undefined || due === undefined ? (
                          <span className="meta">
                            {row.latestNoteAt === null
                              ? t('home.none')
                              : relative(row.latestNoteAt, format, now)}
                          </span>
                        ) : (
                          <>
                            <span className="meta">{due.text}</span>
                            <span className="class-card-title">{next.title}</span>
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
              <li>
                {creating ? (
                  <NewClassForm
                    className="class-card class-card-new"
                    onCreate={(name) => {
                      setCreating(false)
                      onCreateClass(name)
                    }}
                    onCancel={() => setCreating(false)}
                  />
                ) : (
                  <button
                    type="button"
                    className="class-card class-card-new"
                    onClick={() => setCreating(true)}
                  >
                    {t('rail.newClass')}
                  </button>
                )}
              </li>
            </ul>
          </Section>
          {recents.length > 0 && (
            <Section label={t('home.recent')}>
              <ul className="home-rows">
                {recents.map((note) => (
                  <li key={note.id}>
                    <button
                      type="button"
                      className="home-row"
                      onClick={() =>
                        note.pageOrder === null || note.notebookId === null
                          ? onOpenNote(note.id)
                          : onOpenPage(note.notebookId, note.id)
                      }
                    >
                      <Icon
                        name={note.pageOrder === null ? 'file-text' : 'notebook-pen'}
                        className="home-icon"
                      />
                      <span className="home-name">
                        {note.pageOrder === null
                          ? note.title || t('notes.untitled')
                          : t('home.page', {
                              book: books.get(note.notebookId ?? '')?.name ?? '',
                              number: numbers.get(note.id),
                            })}
                      </span>
                      <time className="rail-when" dateTime={note.updatedAt}>
                        {relative(note.updatedAt, format, now)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section
            label={t('home.upcoming')}
            action={
              <button type="button" className="home-new" onClick={() => setAdding(true)}>
                {t('deadlines.create')}
              </button>
            }
          >
            {upcoming.length > 0 && (
              <ul className="home-rows">
                {upcoming.slice(0, UPCOMING).map((row) => {
                  const { text, late } = countdown(row.dueAt, false, now, i18n.language, t)
                  return (
                    <li key={row.id} className="home-deadline" data-late={late}>
                      <span className="meta">{text}</span>
                      <span className="home-name">{row.title}</span>
                      {/* Kept here and not in the recents: a deadline belongs
                          to a class the reader may not be looking at. */}
                      <span className="meta home-class">{place(row.classId)}</span>
                    </li>
                  )
                })}
              </ul>
            )}
            {upcoming.length > UPCOMING && (
              <p className="meta home-more">
                {t('home.more', { count: upcoming.length - UPCOMING })}
              </p>
            )}
          </Section>
          {/* Every active class to pick from, and none picked: a deadline
              added here has no class it is obviously about. */}
          {adding && (
            <DeadlineModal
              classes={classes.map((row) => ({ id: row.id, name: row.name }))}
              onClose={() => setAdding(false)}
            />
          )}
        </>
      )}
    </div>
  )
}
