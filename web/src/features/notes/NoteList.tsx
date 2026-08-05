import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Note } from '../../db/schema.ts'

// ADR 0005: dates are Intl, there is no date library. Coarse and
// approximate is the point — a note list needs "yesterday", not a duration.
const DIVISIONS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
  ['month', 2_592_000_000],
  ['year', 31_536_000_000],
]

// Floored, because no label here is finer than a minute and an unfloored
// clock would push a re-render every tick for a string that never changes.
const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000

// Lower than autosave's 500ms: this is a read, and it has to feel immediate.
const SEARCH_DEBOUNCE_MS = 150

function relative(iso: string, format: Intl.RelativeTimeFormat, now: number) {
  // A note's updatedAt is never in the future. A clock floored past it should
  // read as "now" rather than as a prediction.
  const diff = Math.min(0, new Date(iso).getTime() - now)
  let unit = DIVISIONS[0]!
  for (const division of DIVISIONS) {
    if (Math.abs(diff) >= division[1]) unit = division
  }
  return format.format(Math.round(diff / unit[1]), unit[0])
}

type Props = {
  notes: Note[]
  query: string
  onQueryChange: (query: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

export default function NoteList({
  notes,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  const { t, i18n } = useTranslation()
  const format = useMemo(
    () => new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }),
    [i18n.language],
  )
  const [now, setNow] = useState(currentMinute)
  // The input keeps its own value so typing is never held up by the read.
  const [text, setText] = useState(query)

  useEffect(() => {
    // Bailing out when the two already agree keeps the clear button, which
    // commits immediately, from committing a second time on a timer.
    if (text === query) return
    const timer = setTimeout(() => onQueryChange(text), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, query, onQueryChange])

  useEffect(() => {
    // Returning the previous value when the minute has not rolled over lets
    // React bail out, so a list nobody is touching does not re-render.
    const timer = setInterval(() => {
      setNow((previous) => {
        const minute = currentMinute()
        return minute === previous ? previous : minute
      })
    }, 30_000)
    return () => clearInterval(timer)
  }, [])

  // A query of nothing but spaces matches everything, so it is not a search
  // and the list should not start reporting matches.
  const searching = query.trim() !== ''

  return (
    <nav className="list" aria-label={t('notes.listLabel')}>
      <div className="list-head">
        <h1>{t('app.title')}</h1>
        <button type="button" className="create" onClick={onCreate}>
          {t('notes.create')}
        </button>
      </div>
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
      <p className="count">
        {searching
          ? t('search.matches', { count: notes.length })
          : t('notes.count', { count: notes.length })}
      </p>
      {searching && notes.length === 0 && (
        <p className="empty-list">{t('notes.emptySearch')}</p>
      )}
      <ul>
        {notes.map((note) => {
          const title = note.title || t('notes.untitled')
          return (
            <li key={note.id} className="row">
              <button
                type="button"
                className="open"
                aria-current={note.id === selectedId}
                onClick={() => onSelect(note.id)}
              >
                <span className="row-title">{title}</span>
                <time dateTime={note.updatedAt}>
                  {relative(note.updatedAt, format, now)}
                </time>
              </button>
              <button
                type="button"
                className="discard"
                aria-label={t('notes.delete', { title })}
                onClick={() => {
                  // Soft delete is recoverable in the database, but no UI
                  // recovers it, so to the user this is permanent.
                  if (window.confirm(t('notes.deleteConfirm', { title }))) {
                    onDelete(note.id)
                  }
                }}
              >
                &times;
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
