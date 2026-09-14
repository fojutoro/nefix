import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toggleDone } from '../../db/deadlines.ts'
import type { Deadline } from '../../db/schema.ts'
import { countdown, daysUntil } from './countdown.ts'

type Props = {
  // The class's deadlines, soonest first.
  deadlines: Deadline[]
  now: number
  onAdd: () => void
}

export default function DeadlineList({ deadlines, now, onAdd }: Props) {
  const { t, i18n } = useTranslation()
  const [all, setAll] = useState(false)
  if (deadlines.length === 0) return null

  const upcoming = deadlines.filter(
    (row) => row.doneAt === null && daysUntil(row.dueAt, now) >= 0,
  )
  const hidden = deadlines.length - upcoming.length
  const shown = all ? deadlines : upcoming

  return (
    <section className="deadlines">
      <div className="deadlines-head">
        <h2 className="meta">{t('deadlines.label')}</h2>
        <span className="meta">
          {t('deadlines.upcoming', { count: upcoming.length })}
        </span>
        {(hidden > 0 || all) && (
          <button
            type="button"
            className="deadlines-toggle"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all
              ? t('deadlines.showUpcoming')
              : t('deadlines.showAll', { count: hidden })}
          </button>
        )}
      </div>
      <ul className="deadline-rows">
        {shown.map((row) => {
          const done = row.doneAt !== null
          const { text } = countdown(row.dueAt, done, now, i18n.language, t)
          return (
            <li key={row.id} className="deadline-row" data-done={done}>
              <input
                type="checkbox"
                checked={done}
                aria-label={t('deadlines.done', { title: row.title })}
                onChange={() => void toggleDone(row.id)}
              />
              <span className="meta">{text}</span>
              <span className="deadline-title">{row.title}</span>
            </li>
          )
        })}
        <li className="deadline-row deadline-new">
          <button type="button" onClick={onAdd}>
            {t('deadlines.create')}
          </button>
        </li>
      </ul>
    </section>
  )
}
