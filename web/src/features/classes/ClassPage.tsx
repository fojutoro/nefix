import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Note } from '../../db/schema.ts'
import Icon from '../../ui/Icon.tsx'
import NoteRow from '../notes/NoteRow.tsx'
import { divide, relative, useMinute } from '../notes/relative.ts'
import ActivityStrip from './ActivityStrip.tsx'
import ClassMenu from './ClassMenu.tsx'
import InlineText from './InlineText.tsx'
import type { Selection } from './selection.ts'

// Lower than autosave's 500ms: this is a read, and it has to feel immediate.
const SEARCH_DEBOUNCE_MS = 150

// Under an hour is not a gap worth naming. "Nothing here for 0 days" reads
// worse than nothing at all, so below this the line is simply absent.
const QUIET_MS = 3_600_000

// Past a week the line stops reporting and starts nudging.
const IDLE_MS = 7 * 86_400_000

// A collegebook as the card needs it: the book itself never carries a count
// or a time, and reading its pages in the card would be a query per card
// inside the render.
export type BookCard = {
  id: string
  name: string
  pages: number
  writtenAt: string
}

type Props = {
  kind: Selection['kind']
  heading: string
  code: string | null
  colour: string | null
  semester: string | null
  // The cards, filtered by the search box.
  notes: Note[]
  // The class's collegebooks. Containers you open, so they are not mixed
  // into the list of loose notes below them.
  books: BookCard[]
  // The shelf itself, which the strip and the state line are about: neither
  // should change shape because somebody is typing in the search box.
  all: Note[]
  query: string
  toggle: ReactNode
  // Shown on a first run, when there are no classes to have selected. Part
  // of the page rather than instead of it, or a fresh install would have no
  // way to write a note.
  notice: ReactNode
  onQueryChange: (query: string) => void
  onSelect: (id: string) => void
  onCreate: () => void
  onOpenBook: (id: string) => void
  onCreateBook: (name: string) => void
  onDelete: (id: string) => void
  onRename: (name: string) => void
  onCode: (code: string) => void
  onColour: (colour: string) => void
  onSemester: (semester: string) => void
  onArchive: () => void
  onDeleteClass: () => void
}

export default function ClassPage({
  kind,
  heading,
  code,
  colour,
  semester,
  notes,
  all,
  books,
  query,
  toggle,
  notice,
  onQueryChange,
  onSelect,
  onCreate,
  onOpenBook,
  onCreateBook,
  onDelete,
  onRename,
  onCode,
  onColour,
  onSemester,
  onArchive,
  onDeleteClass,
}: Props) {
  const { t, i18n } = useTranslation()
  const now = useMinute()
  const format = useMemo(
    () => new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }),
    [i18n.language],
  )
  // The day itself, not how long ago it was: the left column is a timeline,
  // and "12 Sep" sorts by eye in a way "three days ago" does not. The order
  // of day and month is the locale's business.
  const date = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        day: 'numeric',
        month: 'short',
      }),
    [i18n.language],
  )
  // The input keeps its own value so typing is never held up by the read.
  const [text, setText] = useState(query)
  // Local, unlike the rail's, because nothing outside this page opens the
  // field: there is no shortcut and no notice that starts a collegebook.
  const [naming, setNaming] = useState(false)
  const [bookName, setBookName] = useState('')

  useEffect(() => {
    // Bailing out when the two already agree keeps the clear button, which
    // commits immediately, from committing a second time on a timer.
    if (text === query) return
    const timer = setTimeout(() => onQueryChange(text), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, query, onQueryChange])

  // A query of nothing but spaces matches everything, so it is not a search
  // and the line should not start reporting matches.
  const searching = query.trim() !== ''

  // Phrased to be acted on rather than to be accurate: "nothing here for
  // three weeks" is what gets a class opened, and "last updated 21 days ago"
  // is what gets skimmed past.
  let state: string | null
  if (searching) state = t('search.matches', { count: notes.length })
  else if (all.length === 0) {
    state = kind === 'today' ? t('rail.todayEmpty') : t('state.none')
  } else {
    const newest = all.reduce(
      (latest, note) => (note.updatedAt > latest ? note.updatedAt : latest),
      all[0]!.updatedAt,
    )
    const idle = now - new Date(newest).getTime()
    if (idle < QUIET_MS) state = null
    else if (idle < IDLE_MS) {
      // A point in the past, so RelativeTimeFormat, which is also the only
      // one of the two that declines the unit: Slovak's "pred" takes the
      // instrumental, and "pred 3 dňami" is not a number plus a noun.
      state = t('state.recent', { when: relative(newest, format, now) })
    } else {
      // A span rather than a point — "nothing here for three weeks" — which
      // has no relative formatter and wants the plain plural.
      const [unit, value] = divide(newest, now)
      state = t('state.idle', {
        when: new Intl.NumberFormat(i18n.language, {
          style: 'unit',
          unit,
          unitDisplay: 'long',
        }).format(value),
      })
    }
  }

  return (
    <div className="page">
      {toggle}
      <header className="page-head">
        <div className="page-title">
          {/* A class is renameable in place; Today and Unfiled are not
              classes and have nothing to rename. */}
          <h1>
            {kind === 'class' ? (
              <InlineText
                value={heading}
                label={t('class.rename')}
                placeholder={heading}
                onCommit={onRename}
              />
            ) : (
              heading
            )}
          </h1>
          {state !== null && <p className="state">{state}</p>}
        </div>
        {kind === 'class' && (
          <div className="page-controls">
            <InlineText
              value={code ?? ''}
              label={t('class.code')}
              placeholder={t('class.addCode')}
              className="meta"
              onCommit={onCode}
            />
            <ClassMenu
              colour={colour}
              semester={semester}
              onColour={onColour}
              onSemester={onSemester}
              onArchive={onArchive}
              onDelete={onDeleteClass}
            />
          </div>
        )}
      </header>
      {/* Only a class has weeks. Today is every class at once, and Unfiled is
          not a course. */}
      {kind === 'class' && <ActivityStrip notes={all} />}
      {notice}
      {/* The deadline lands here in a later change. Deliberately empty: the
          gap is built now so the page does not move when it arrives. */}
      <div className="slot" />
      {/* Cards rather than rows, because a collegebook is a container you
          open and a note is a document you read. Mixing them into one list
          would make the two look like the same kind of thing. */}
      <section className="books">
        <h2 className="meta">{t('books.label')}</h2>
        <ul>
          {books.map((book) => (
            <li key={book.id}>
              <button
                type="button"
                className="book-card"
                onClick={() => onOpenBook(book.id)}
              >
                <Icon name="notebook-pen" />
                <span className="book-title">{book.name}</span>
                <span className="meta">
                  {t('books.pages', { count: book.pages })}
                </span>
                <span className="meta">
                  {relative(book.writtenAt, format, now)}
                </span>
              </button>
            </li>
          ))}
          <li>
            {naming ? (
              <form
                className="book-card book-naming"
                onSubmit={(event) => {
                  event.preventDefault()
                  const trimmed = bookName.trim()
                  // A book is named after a course or a term, so there is no
                  // untitled one to create.
                  if (trimmed === '') return
                  setBookName('')
                  setNaming(false)
                  onCreateBook(trimmed)
                }}
              >
                <input
                  autoFocus
                  value={bookName}
                  aria-label={t('books.name')}
                  placeholder={t('books.name')}
                  onChange={(event) => setBookName(event.target.value)}
                  onKeyDown={(event) => {
                    // Held here, or Escape closes the page behind the field.
                    if (event.key !== 'Escape') return
                    event.stopPropagation()
                    setNaming(false)
                    setBookName('')
                  }}
                  onBlur={() => setNaming(false)}
                />
              </form>
            ) : (
              <button
                type="button"
                className="book-card book-new"
                onClick={() => setNaming(true)}
              >
                {t('books.create')}
              </button>
            )}
          </li>
        </ul>
      </section>
      <div className="page-tools">
        <div className="search">
          <input
            type="search"
            value={text}
            aria-label={t('search.label')}
            placeholder={t('search.placeholder')}
            onChange={(event) => setText(event.target.value)}
          />
          {text !== '' && (
            <button
              type="button"
              className="clear"
              aria-label={t('search.clear')}
              onClick={() => {
                setText('')
                onQueryChange('')
              }}
            >
              &times;
            </button>
          )}
        </div>
      </div>
      <ul className="toc" aria-label={t('notes.listLabel')}>
        {notes.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            date={date}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))}
        {/* One more line in the list rather than a card competing with it:
            the date column empty, and the label where a title would be. */}
        <li className="toc-row toc-new">
          <button type="button" className="toc-open" onClick={onCreate}>
            <span className="toc-body">
              <span className="toc-title">{t('notes.create')}</span>
            </span>
          </button>
        </li>
      </ul>
      {searching && notes.length === 0 && (
        <p className="empty-list">{t('notes.emptySearch')}</p>
      )}
    </div>
  )
}
