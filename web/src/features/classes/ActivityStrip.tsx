import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Note } from '../../db/schema.ts'

// One per week of a semester. The window is fixed and starts at the earliest
// note, which is chosen rather than missed: a sliding window of the last
// fourteen weeks would always include now and would stop meaning "the
// semester", and the semester's real dates are what a later semester field
// will supply. Until then a class in its twentieth week shows a strip that
// ends at week fourteen.
const WEEKS = 14

const DAY_MS = 86_400_000

// One crimson mark among thirteen blanks looks like an error rather than a
// record, and a class two weeks old has nothing to say yet.
const FLOOR = 3

// How dark a mark is drawn: one note is faint, five or more is full, so a
// glance carries how much as well as when.
const weightOf = (count: number): number => {
  if (count === 0) return 0
  if (count === 1) return 1
  if (count === 2) return 2
  return count < 5 ? 3 : 4
}

// Monday 00:00 local. Dates are stepped with setDate rather than by adding
// milliseconds, because a week is not always 604800000ms: twice a year the
// clocks move and an arithmetic week lands an hour into the wrong day.
function mondayOf(at: number): Date {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  // getDay counts from Sunday, which is the last day of its week here, not
  // the first.
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day
}

export default function ActivityStrip({ notes }: { notes: Note[] }) {
  const { t, i18n } = useTranslation()
  const range = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        day: 'numeric',
        month: 'short',
      }),
    [i18n.language],
  )
  // A month is a thing a student feels. A week number is not.
  const month = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short' }),
    [i18n.language],
  )

  const cells = useMemo(() => {
    if (notes.length === 0) return null
    const times = notes.map((note) => new Date(note.updatedAt).getTime())
    const first = mondayOf(Math.min(...times))

    const starts: number[] = []
    for (let week = 0; week <= WEEKS; week++) {
      starts.push(first.getTime())
      first.setDate(first.getDate() + 7)
    }

    return starts.slice(0, WEEKS).map((start, week) => {
      const end = starts[week + 1]!
      return {
        start,
        end,
        // Past the window is not counted rather than clamped into the last
        // cell, which would claim work that was not done that week.
        count: times.filter((time) => time >= start && time < end).length,
      }
    })
  }, [notes])

  // Absent, not empty. A strip of fourteen blanks says the class was silent
  // for a semester; a class with nothing in it has not had one yet.
  if (cells === null) return null
  if (cells.filter((cell) => cell.count > 0).length < FLOOR) return null

  return (
    <div className="strip">
      <ul aria-label={t('class.activity')}>
        {cells.map((cell) => (
          <li
            key={cell.start}
            data-weight={weightOf(cell.count)}
            title={`${range.formatRange(cell.start, cell.end - DAY_MS)} · ${t(
              'notes.count',
              { count: cell.count },
            )}`}
          />
        ))}
      </ul>
      <p className="strip-scale">
        <span>{month.format(cells[0]!.start)}</span>
        <span>{month.format(cells[cells.length - 1]!.start)}</span>
      </p>
    </div>
  )
}
