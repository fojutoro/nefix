import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { createDeadline } from '../../db/deadlines.ts'
import { normalize } from '../../db/normalize.ts'
import { listHeadings, type Heading } from '../../db/notes.ts'
import type { Deadline, Topic } from '../../db/schema.ts'

const KINDS: Deadline['kind'][] = ['test', 'assignment', 'other']

// Enough to choose from. Past this, another letter is faster than scrolling.
const SUGGESTIONS = 8

type Place = { id: string; name: string }

type Option = Topic & { noteTitle?: string }

type Props = {
  // Set where the class is already decided, and shown as context. Unset, the
  // class is a field that starts at none.
  fixedClass?: Place
  classes?: Place[]
  onClose: () => void
}

export default function DeadlineModal({ fixedClass, classes = [], onClose }: Props) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [kind, setKind] = useState<Deadline['kind']>('test')
  const [note, setNote] = useState('')
  const [classId, setClassId] = useState(fixedClass?.id ?? null)
  const [topics, setTopics] = useState<Topic[]>([])
  const [text, setText] = useState('')
  const [picked, setPicked] = useState(0)
  const [headings, setHeadings] = useState<Heading[]>([])

  // Once per opening, never per keystroke: listHeadings parses every note in
  // scope. Everything below filters this in memory.
  const scope = fixedClass?.id
  useEffect(() => {
    let open = true
    void listHeadings(scope).then((found) => {
      if (open) setHeadings(found)
    })
    return () => {
      open = false
    }
  }, [scope])

  const query = normalize(text)
  const chosen = (option: Topic) =>
    topics.some((topic) => topic.noteId === option.noteId && topic.heading === option.heading)
  const matches =
    query === ''
      ? []
      : headings
          .filter((row) => normalize(row.heading).includes(query) && !chosen(row))
          .slice(0, SUGGESTIONS)
  // Free text only when nothing matches: offering "mnoz" beside Množiny would
  // make the typo the easier thing to pick.
  const options: Option[] =
    query === '' || matches.length > 0
      ? matches
      : [{ noteId: null, heading: text.trim() }]

  const add = (option: Option) => {
    setTopics([...topics, { noteId: option.noteId, heading: option.heading }])
    setText('')
    setPicked(0)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = title.trim()
    if (trimmed === '' || due === '') return
    await createDeadline({
      title: trimmed,
      dueAt: `${due}T00:00:00.000Z`,
      kind,
      classId,
      note: note.trim() === '' ? null : note,
      topics,
    })
    onClose()
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form
        className="deadline-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('deadlines.new')}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          // Held here, or Escape also leaves the page behind the modal.
          if (event.key !== 'Escape') return
          event.stopPropagation()
          onClose()
        }}
      >
        {fixedClass ? (
          <p className="meta">{fixedClass.name}</p>
        ) : (
          <label className="field">
            <span className="meta">{t('deadlines.class')}</span>
            <select
              value={classId ?? ''}
              onChange={(event) => setClassId(event.target.value || null)}
            >
              <option value="">{t('deadlines.noClass')}</option>
              {classes.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="meta">{t('deadlines.title')}</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field">
          <span className="meta">{t('deadlines.due')}</span>
          <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
        </label>
        <fieldset className="field">
          <legend className="meta">{t('deadlines.kind')}</legend>
          <div className="set-choice" role="radiogroup" aria-label={t('deadlines.kind')}>
            {KINDS.map((option) => (
              <label key={option} className="set-segment">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === option}
                  onChange={() => setKind(option)}
                />
                {t(`deadlines.kind.${option}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="meta">{t('deadlines.note')}</span>
          <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <div className="field">
          <label className="field">
            <span className="meta">{t('deadlines.topics')}</span>
            <input
              role="combobox"
              aria-expanded={options.length > 0}
              aria-controls="topic-options"
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                setPicked(0)
              }}
              onKeyDown={(event) => {
                if (options.length === 0) return
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const step = event.key === 'ArrowDown' ? 1 : -1
                  setPicked((picked + step + options.length) % options.length)
                } else if (event.key === 'Enter') {
                  // A topic, not the form: Enter submits only once the field
                  // is empty.
                  event.preventDefault()
                  add(options[Math.min(picked, options.length - 1)]!)
                }
              }}
            />
          </label>
          {topics.length > 0 && (
            <ul className="chips">
              {topics.map((topic, index) => (
                <li
                  key={`${topic.noteId}:${topic.heading}`}
                  className={topic.noteId === null ? 'chip chip-loose' : 'chip'}
                >
                  {topic.heading}
                  <button
                    type="button"
                    aria-label={t('deadlines.removeTopic', { heading: topic.heading })}
                    onClick={() => setTopics(topics.filter((_, at) => at !== index))}
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          )}
          {options.length > 0 && (
            <ul id="topic-options" className="topic-options" role="listbox">
              {options.map((option, index) => (
                <li
                  key={`${option.noteId}:${option.heading}`}
                  role="option"
                  aria-selected={index === picked}
                  // mousedown, so the field keeps focus and the next topic can
                  // be typed straight away.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    add(option)
                  }}
                >
                  {option.noteId === null ? (
                    t('deadlines.addTopic', { text: option.heading })
                  ) : (
                    <>
                      <span>{option.heading}</span>
                      <span className="meta">{option.noteTitle || t('notes.untitled')}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t('deadlines.cancel')}
          </button>
          <button type="submit">{t('deadlines.save')}</button>
        </div>
      </form>
    </div>
  )
}
