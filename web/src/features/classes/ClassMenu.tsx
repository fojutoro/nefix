import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import InlineText from './InlineText.tsx'

// Six, because six is enough for a semester and a colour picker is a decision
// nobody opened this menu wanting to make.
const COLOURS = [
  '#9b1c2e',
  '#1d4ed8',
  '#15803d',
  '#b45309',
  '#6d28d9',
  '#0e7490',
]

type Props = {
  colour: string | null
  semester: string | null
  onColour: (colour: string) => void
  onSemester: (semester: string) => void
  onArchive: () => void
  onDelete: () => void
}

export default function ClassMenu({
  colour,
  semester,
  onColour,
  onSemester,
  onArchive,
  onDelete,
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Before the window listener that leaves the editor: with a menu open,
      // the menu is what Escape is about.
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        className="menu-open"
        aria-expanded={open}
        aria-label={t('class.menu')}
        onClick={() => setOpen(!open)}
      >
        &hellip;
      </button>
      {open && (
        <div className="menu-panel">
          <p className="meta">{t('class.colour')}</p>
          <div className="swatches">
            {COLOURS.map((option, index) => (
              <button
                key={option}
                type="button"
                className="swatch"
                style={{ background: option }}
                aria-label={t('class.colourOption', { n: index + 1 })}
                aria-current={option === colour}
                onClick={() => {
                  onColour(option)
                  setOpen(false)
                }}
              />
            ))}
          </div>
          <p className="meta">{t('class.semester')}</p>
          <InlineText
            value={semester ?? ''}
            label={t('class.semester')}
            placeholder={t('class.addSemester')}
            className="menu-item"
            onCommit={onSemester}
          />
          {/* Archive first and delete last: the gentle answer is the one that
              should be easiest to reach for. */}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              onArchive()
            }}
          >
            {t('class.archive')}
          </button>
          <button
            type="button"
            className="menu-item menu-danger"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            {t('class.delete')}
          </button>
        </div>
      )}
    </div>
  )
}
