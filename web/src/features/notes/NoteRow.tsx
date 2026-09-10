import { useTranslation } from 'react-i18next'
import type { Note } from '../../db/schema.ts'
import { outline } from './outline.ts'

// Six is what fits on one line at this width. A seventh would wrap the row
// and cost the list its rhythm, so the rest are counted instead.
const SHOWN = 6

type Props = {
  note: Note
  // Built once by the list rather than per row: forty rows would otherwise
  // construct forty identical formatters.
  date: Intl.DateTimeFormat
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

export default function NoteRow({ note, date, onSelect, onDelete }: Props) {
  const { t } = useTranslation()
  const title = note.title || t('notes.untitled')
  const headings = outline(note.bodyMd)
  const shown = headings.slice(0, SHOWN)
  const rest = headings.length - shown.length

  return (
    <li className="toc-row">
      <button
        type="button"
        className="toc-open"
        onClick={() => onSelect(note.id)}
      >
        {/* The title leads in the source and the date is placed into the
            left column by the grid. Read aloud, a row is its title and then
            when it was written; seen, the dates line up into a timeline. */}
        <span className="toc-body">
          <span className="toc-title">{title}</span>
          {/* Nothing at all when there are none: no placeholder, no dash, and
              a row half the height. */}
          {shown.length > 0 && (
            <span className="toc-outline">
              {rest > 0
                ? `${shown.join(' · ')} · ${t('notes.moreHeadings', { count: rest })}`
                : shown.join(' · ')}
            </span>
          )}
        </span>
        <time className="meta toc-when" dateTime={note.updatedAt}>
          {date.format(new Date(note.updatedAt))}
        </time>
      </button>
      {/* Revealed on hover and on focus. A column of delete buttons is a
          column you cannot read, and one that only appears on hover is one a
          keyboard cannot reach. */}
      <button
        type="button"
        className="toc-discard"
        aria-label={t('notes.delete', { title })}
        onClick={() => {
          // Soft delete is recoverable in the database, but no UI recovers
          // it, so to the user this is permanent.
          if (window.confirm(t('notes.deleteConfirm', { title }))) {
            onDelete(note.id)
          }
        }}
      >
        &times;
      </button>
    </li>
  )
}
