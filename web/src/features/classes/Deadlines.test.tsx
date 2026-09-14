import 'fake-indexeddb/auto'
import { useEffect, useState } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClass } from '../../db/classes.ts'
import {
  createDeadline,
  listDeadlines,
  observeDeadlines,
} from '../../db/deadlines.ts'
import { listNotebooks } from '../../db/notebooks.ts'
import { createNote, listHeadings } from '../../db/notes.ts'
import { db, type Deadline } from '../../db/schema.ts'
import i18n from '../../i18n/index.ts'
import CSS from '../../index.css?raw'
import DeadlineList from './DeadlineList.tsx'
import DeadlineModal from './DeadlineModal.tsx'
import NextDeadline from './NextDeadline.tsx'

// The real read, counted: the modal must load headings once and filter them in
// memory, and the count is the only thing that can tell those two apart.
vi.mock('../../db/notes.ts', async (original) => {
  const actual = await original<typeof import('../../db/notes.ts')>()
  return { ...actual, listHeadings: vi.fn(actual.listHeadings) }
})

const NOW = Date.now()

// N days from the reader's today, as a stored dueAt.
function dueIn(offset: number): string {
  const today = new Date()
  const shifted = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const date = String(shifted.getDate()).padStart(2, '0')
  return `${shifted.getFullYear()}-${month}-${date}T00:00:00.000Z`
}

const row = (title: string, offset: number, extra: Partial<Deadline> = {}): Deadline => ({
  id: title,
  classId: 'class',
  title,
  kind: 'test',
  dueAt: dueIn(offset),
  note: null,
  topics: [],
  doneAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  deletedAt: null,
  version: 0,
  dirty: true,
  syncedAt: null,
  ...extra,
})

const DONE = { doneAt: '2026-09-01T10:00:00.000Z' }

const card = () => screen.getByRole('region', { name: 'Next deadline' })

const titles = () =>
  [...document.querySelectorAll('.deadline-title')].map((node) => node.textContent)

// Wired the way App.tsx wires the page: through the store's subscription, so a
// tick has to travel through IndexedDB to leave the list.
function Live({ classId }: { classId: string }) {
  const [rows, setRows] = useState<Deadline[]>([])
  useEffect(() => {
    const watch = observeDeadlines(classId).subscribe(setRows)
    return () => watch.unsubscribe()
  }, [classId])
  return <DeadlineList deadlines={rows} now={NOW} onAdd={() => {}} />
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  await db.deadlines.clear()
  await db.notes.clear()
  await db.notebooks.clear()
  await db.classes.clear()
  vi.mocked(listHeadings).mockClear()
})

afterEach(() => {
  cleanup()
})

describe('NextDeadline', () => {
  it('shows the soonest outstanding deadline', () => {
    // A done one first in due order, so "the first row" is not "the next".
    render(
      <NextDeadline
        deadlines={[row('Hotové', 1, DONE), row('Písomka', 3), row('Zápočet', 10)]}
        now={NOW}
        onOpenTopic={vi.fn()}
      />,
    )

    expect(card().textContent).toContain('in 3 days')
    expect(card().textContent).toContain('Písomka')
    expect(card().textContent).not.toContain('Zápočet')
    expect(card().getAttribute('data-late')).toBe('false')
  })

  it('is absent when nothing is outstanding', () => {
    const { container } = render(
      <NextDeadline deadlines={[row('Hotové', 2, DONE)]} now={NOW} onOpenTopic={vi.fn()} />,
    )

    expect(container.innerHTML).toBe('')
  })

  it('says how late an overdue deadline is and takes the danger colour', () => {
    render(<NextDeadline deadlines={[row('Zadanie', -2)]} now={NOW} onOpenTopic={vi.fn()} />)

    expect(card().querySelector('.meta')?.textContent).toBe('2 days late')
    expect(card().getAttribute('data-late')).toBe('true')
    expect(CSS).toMatch(
      /\.next-deadline\[data-late='true'\] \.meta \{\s*color: var\(--danger\);/,
    )
  })

  it('says today for a deadline due today, and it is not late', () => {
    render(<NextDeadline deadlines={[row('Písomka', 0)]} now={NOW} onOpenTopic={vi.fn()} />)

    expect(card().querySelector('.meta')?.textContent).toBe('today')
    expect(card().getAttribute('data-late')).toBe('false')
  })
})

describe('DeadlineList', () => {
  it('shows upcoming only, and done and overdue on the toggle', () => {
    render(
      <DeadlineList
        deadlines={[row('Zmeškané', -2), row('Hotové', 1, DONE), row('Písomka', 4)]}
        now={NOW}
        onAdd={vi.fn()}
      />,
    )

    expect(titles()).toEqual(['Písomka'])

    fireEvent.click(screen.getByRole('button', { name: 'Show done and overdue (2)' }))

    expect(titles()).toEqual(['Zmeškané', 'Hotové', 'Písomka'])
    const done = screen.getByText('Hotové').closest('li')!
    expect(done.getAttribute('data-done')).toBe('true')
    expect(CSS).toMatch(
      /\.deadline-row\[data-done='true'\] \.deadline-title \{\s*color: var\(--text-muted\);\s*text-decoration: line-through;/,
    )
  })

  it('moves a ticked-off deadline out of the default view', async () => {
    await createDeadline({ title: 'Písomka', dueAt: dueIn(2), classId: 'class' })
    await createDeadline({ title: 'Zápočet', dueAt: dueIn(5), classId: 'class' })
    render(<Live classId="class" />)
    await waitFor(() => expect(titles()).toEqual(['Písomka', 'Zápočet']))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Písomka done' }))

    await waitFor(() => expect(titles()).toEqual(['Zápočet']))
    const [ticked] = await listDeadlines('class')
    expect(ticked!.doneAt).not.toBeNull()
  })
})

describe('DeadlineModal', () => {
  async function seedClass() {
    const created = await createClass({ name: 'Diskrétna matematika' })
    const notebook = (await listNotebooks(created.id))[0]!
    const sets = await createNote({
      title: 'Množiny a relácie',
      bodyMd: '# Množiny a relácie\n\n## Množiny\n\n## Operácie',
      notebookId: notebook.id,
    })
    await createNote({
      title: 'Logika',
      bodyMd: '# Logika\n\n## Množiny\n\n## Výroky',
      notebookId: notebook.id,
    })
    return { created, sets }
  }

  const options = () =>
    screen.queryAllByRole('option').map((node) => node.textContent).sort()

  const fill = (title: string, offset: number) => {
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: title } })
    fireEvent.change(screen.getByLabelText('Due date'), {
      target: { value: dueIn(offset).slice(0, 10) },
    })
  }

  it('creates a deadline in the class it was opened on', async () => {
    const { created } = await seedClass()
    const onClose = vi.fn()
    render(
      <DeadlineModal fixedClass={{ id: created.id, name: created.name }} onClose={onClose} />,
    )
    const dialog = screen.getByRole('dialog', { name: 'New deadline' })

    // Context, not a field.
    expect(within(dialog).getByText('Diskrétna matematika')).not.toBeNull()
    expect(within(dialog).queryByRole('combobox', { name: 'Class' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText('Title'))

    fill('Test — Množiny a relácie', 3)
    fireEvent.click(screen.getByRole('radio', { name: 'Assignment' }))
    fireEvent.submit(dialog)

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await listDeadlines()).toMatchObject([
      {
        classId: created.id,
        title: 'Test — Množiny a relácie',
        kind: 'assignment',
        dueAt: dueIn(3),
        topics: [],
      },
    ])
  })

  it('does nothing with an empty title', async () => {
    const onClose = vi.fn()
    render(<DeadlineModal onClose={onClose} />)

    fill('   ', 3)
    await act(async () => {
      fireEvent.submit(screen.getByRole('dialog'))
    })

    expect(await listDeadlines()).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('filters the headings it loaded without reading them again', async () => {
    const { created } = await seedClass()
    render(<DeadlineModal fixedClass={{ id: created.id, name: created.name }} onClose={vi.fn()} />)
    const topics = screen.getByRole('combobox', { name: 'Topics' })

    for (const text of ['m', 'mn', 'mno', 'mnoz']) {
      fireEvent.change(topics, { target: { value: text } })
    }
    // Two headings with one name, told apart by the note each is in.
    await waitFor(() =>
      expect(options()).toEqual(['MnožinyLogika', 'MnožinyMnožiny a relácie']),
    )

    fireEvent.change(topics, { target: { value: 'oper' } })
    expect(options()).toEqual(['OperácieMnožiny a relácie'])

    expect(listHeadings).toHaveBeenCalledTimes(1)
  })

  it('stores a heading with its note and free text with a null note', async () => {
    const { created, sets } = await seedClass()
    const onClose = vi.fn()
    render(<DeadlineModal fixedClass={{ id: created.id, name: created.name }} onClose={onClose} />)
    const topics = screen.getByRole('combobox', { name: 'Topics' })

    fireEvent.change(topics, { target: { value: 'Rekurzia' } })
    expect(options()).toEqual(['Add “Rekurzia” as a topic'])
    fireEvent.keyDown(topics, { key: 'Enter' })

    fireEvent.change(topics, { target: { value: 'Operácie' } })
    await waitFor(() => expect(options()).toEqual(['OperácieMnožiny a relácie']))
    fireEvent.keyDown(topics, { key: 'Enter' })

    const loose = screen.getByText('Rekurzia').closest('li')!
    expect(loose.className).toContain('chip-loose')
    expect(screen.getByText('Operácie').closest('li')!.className).not.toContain('chip-loose')

    fill('Písomka', 4)
    fireEvent.submit(screen.getByRole('dialog'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const [saved] = await listDeadlines()
    expect(saved!.topics).toEqual([
      { noteId: null, heading: 'Rekurzia' },
      { noteId: sets.id, heading: 'Operácie' },
    ])
  })
})
