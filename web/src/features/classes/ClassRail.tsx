import {
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { ClassWithRecency } from '../../db/classes.ts'
import type { Class } from '../../db/schema.ts'
import { relative, useMinute } from '../notes/relative.ts'
import { keyOf, TODAY, type Selection } from './selection.ts'

type RowProps = {
  label: string
  current: boolean
  onClick: () => void
  colour?: string | null
  trailing?: ReactNode
  // Truncation loses the name, and a rail 180px wide truncates most of them.
  title?: string
  className?: string
}

function Row({
  label,
  current,
  onClick,
  colour,
  trailing,
  title,
  className,
}: RowProps) {
  return (
    <li>
      {/* The spine is the class colour, drawn full height down the left edge
          of the row so the rail reads like books on a shelf. Crimson when
          selected, which is why it is a variable and not a background. */}
      <button
        type="button"
        className={className === undefined ? 'rail-row' : `rail-row ${className}`}
        aria-current={current}
        onClick={onClick}
        style={colour == null ? undefined : ({ '--spine': colour } as CSSProperties)}
      >
        <span className="rail-name" title={title}>
          {label}
        </span>
        {trailing}
      </button>
    </li>
  )
}

type Props = {
  classes: ClassWithRecency[]
  archived: Class[]
  unfiledCount: number
  selection: Selection
  creating: boolean
  onSelect: (selection: Selection) => void
  onCreatingChange: (creating: boolean) => void
  onCreate: (name: string) => void
}

export default function ClassRail({
  classes,
  archived,
  unfiledCount,
  selection,
  creating,
  onSelect,
  onCreatingChange,
  onCreate,
}: Props) {
  const { t, i18n } = useTranslation()
  // Narrow, which is what turns "2 hours ago" into the two-character column
  // the rail has room for. Always numeric, because "the day before
  // yesterday" is a sentence and this is a column.
  const format = useMemo(
    () =>
      new Intl.RelativeTimeFormat(i18n.language, {
        numeric: 'always',
        style: 'narrow',
      }),
    [i18n.language],
  )
  const [name, setName] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const now = useMinute()
  const current = keyOf(selection)

  const when = (iso: string | null) =>
    iso === null ? null : (
      <time className="rail-when" dateTime={iso}>
        {relative(iso, format, now)}
      </time>
    )

  const cancel = () => {
    setName('')
    onCreatingChange(false)
  }

  // Archived classes reach this without a recency column. What an archived
  // class was last touched at is not something to act on, and the column is
  // there to be acted on.
  const classRow = (row: Class, trailing: ReactNode) => (
    <Row
      key={row.id}
      label={row.name}
      colour={row.colour}
      current={current === `class:${row.id}`}
      onClick={() => onSelect({ kind: 'class', classId: row.id })}
      trailing={trailing}
      title={row.name}
    />
  )

  return (
    <nav className="rail-nav" aria-label={t('rail.label')}>
      {/* Today is a shortcut and not the heading of the rail, so it is set
          small and tracked and given no label of its own: a label over a
          group of one is noise. */}
      <ul>
        <Row
          label={t('rail.today')}
          current={current === 'today'}
          onClick={() => onSelect(TODAY)}
          className="rail-shortcut"
        />
      </ul>
      {classes.length > 0 && (
        // Outside the list, because a label is not one of the things in it.
        <p className="rail-label">{t('rail.label')}</p>
      )}
      <ul>
        {classes.map((row) => classRow(row, when(row.latestNoteAt)))}
      </ul>
      {/* An empty bucket is clutter, and so is the space one would have
          taken: with neither row to show there is no group here at all. */}
      {(unfiledCount > 0 || archived.length > 0) && (
        <ul className="rail-rest">
          {unfiledCount > 0 && (
            <Row
              label={t('rail.unfiled')}
              current={current === 'unfiled'}
              onClick={() => onSelect({ kind: 'unfiled' })}
              trailing={<span className="rail-when">{unfiledCount}</span>}
              className="rail-shortcut"
            />
          )}
          {archived.length > 0 && (
            <li>
              <button
                type="button"
                className="rail-row rail-shortcut"
                aria-expanded={showArchived}
                onClick={() => setShowArchived(!showArchived)}
              >
                <span className="rail-name">{t('rail.archived')}</span>
              </button>
            </li>
          )}
          {showArchived && archived.map((row) => classRow(row, null))}
        </ul>
      )}
      {creating ? (
        <form
          className="rail-create"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = name.trim()
            // An empty name does nothing. A class is named after something
            // that exists, so there is no "Untitled" class to create.
            if (trimmed === '') return
            setName('')
            onCreate(trimmed)
          }}
        >
          <input
            autoFocus
            value={name}
            aria-label={t('rail.className')}
            placeholder={t('rail.className')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              // Kept off the window listener that closes the drawer: while
              // this field has focus, Escape means cancel the row.
              event.stopPropagation()
              cancel()
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          className="rail-new"
          onClick={() => onCreatingChange(true)}
        >
          {t('rail.newClass')}
        </button>
      )}
    </nav>
  )
}
