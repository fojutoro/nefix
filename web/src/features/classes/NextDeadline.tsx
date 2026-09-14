import { useTranslation } from 'react-i18next'
import type { Deadline, Topic } from '../../db/schema.ts'
import { countdown } from './countdown.ts'

type Props = {
  // The class's deadlines, soonest first.
  deadlines: Deadline[]
  now: number
  onOpenTopic: (topic: Topic) => void
}

export default function NextDeadline({ deadlines, now, onOpenTopic }: Props) {
  const { t, i18n } = useTranslation()
  // The first outstanding one, which is the oldest miss before anything
  // upcoming: a test nobody ticked off is still the thing to act on, and
  // ticking it is what makes room for the next.
  const next = deadlines.find((row) => row.doneAt === null)
  if (next === undefined) return null
  const { text, late } = countdown(next.dueAt, false, now, i18n.language, t)

  return (
    <section
      className="next-deadline"
      data-late={late}
      aria-label={t('deadlines.next')}
    >
      <p className="meta">{text}</p>
      <p className="next-title">{next.title}</p>
      {next.topics.length > 0 && (
        <ul className="chips">
          {next.topics.map((topic, index) => (
            <li key={index}>
              {topic.noteId === null ? (
                <span className="chip chip-loose" title={t('deadlines.unwritten')}>
                  {topic.heading}
                </span>
              ) : (
                <button
                  type="button"
                  className="chip"
                  onClick={() => onOpenTopic(topic)}
                >
                  {topic.heading}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
