import 'fake-indexeddb/auto'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { archiveClass, createClass } from '../../db/classes.ts'
import { createDeadline, toggleDone } from '../../db/deadlines.ts'
import { createCollegebook, listNotebooks } from '../../db/notebooks.ts'
import {
  createNote,
  createPage,
  insertPageAfter,
  listPages,
} from '../../db/notes.ts'
import { db } from '../../db/schema.ts'
import i18n from '../../i18n/index.ts'
import CSS from '../../index.css?raw'
import Home from './Home.tsx'

// N days from the reader's today, as a stored dueAt.
function dueIn(offset: number): string {
  const today = new Date()
  const shifted = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const date = String(shifted.getDate()).padStart(2, '0')
  return `${shifted.getFullYear()}-${month}-${date}T00:00:00.000Z`
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

const show = () => {
  const props = {
    onOpenNote: vi.fn(),
    onOpenPage: vi.fn(),
    onOpenClass: vi.fn(),
    onCreateClass: vi.fn(),
  }
  render(<Home toggle={null} {...props} />)
  return props
}

const region = (name: string) => screen.findByRole('region', { name })

// The class cards, without the card that makes a new one.
const cards = async () =>
  [...(await region('Classes')).querySelectorAll<HTMLElement>('.class-card')].filter(
    (card) => !card.classList.contains('class-card-new'),
  )

const card = async (name: string) => {
  const found = (await cards()).find(
    (node) => node.querySelector('.class-card-name')?.textContent === name,
  )
  if (found === undefined) throw new Error(`no card for ${name}`)
  return found
}

const slot = async (name: string) =>
  (await card(name)).querySelector('.class-card-slot')?.textContent

const upcomingRows = async () =>
  [...(await region('Upcoming')).querySelectorAll('li')].map((row) =>
    [...row.children].map((cell) => cell.textContent),
  )

beforeEach(async () => {
  await i18n.changeLanguage('en')
  await db.deadlines.clear()
  await db.notes.clear()
  await db.notebooks.clear()
  await db.classes.clear()
})

afterEach(() => {
  cleanup()
})

describe('Home class cards', () => {
  it("shows each class its own next deadline, not the page's soonest", async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const principles = await createClass({ name: 'Princípy počítačov' })
    // The soonest outstanding deadline on the page is the other class's, and
    // this class's own soonest by date is already done.
    await createDeadline({ title: 'Assignment 3', dueAt: dueIn(2), classId: principles.id })
    await createDeadline({ title: 'Test', dueAt: dueIn(3), classId: discrete.id })
    const done = await createDeadline({ title: 'Hotové', dueAt: dueIn(1), classId: discrete.id })
    await toggleDone(done.id)
    show()

    await waitFor(async () => expect(await cards()).toHaveLength(2))

    expect(await slot('Diskrétna matematika')).toBe('in 3 daysTest')
    expect(await slot('Princípy počítačov')).toBe('in 2 daysAssignment 3')
  })

  it('shows how long since it was written in without a deadline, and a dash for a class never written in', async () => {
    const principles = await createClass({ name: 'Princípy počítačov' })
    await createClass({ name: 'Analýza' })
    const general = (await listNotebooks(principles.id))[0]!
    const note = await createNote({ title: 'Logické obvody', notebookId: general.id })
    await db.notes.update(note.id, { updatedAt: hoursAgo(72) })
    const done = await createDeadline({ title: 'Hotové', dueAt: dueIn(4), classId: principles.id })
    await toggleDone(done.id)
    show()

    await waitFor(async () => expect(await cards()).toHaveLength(2))

    expect(await slot('Princípy počítačov')).toBe('3d ago')
    expect(await slot('Analýza')).toBe('—')
  })

  it('gives the card carrying an overdue deadline the danger treatment', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const principles = await createClass({ name: 'Princípy počítačov' })
    await createDeadline({ title: 'Zadanie', dueAt: dueIn(-2), classId: discrete.id })
    await createDeadline({ title: 'Písomka', dueAt: dueIn(0), classId: principles.id })
    show()

    await waitFor(async () => expect(await cards()).toHaveLength(2))

    expect(await slot('Diskrétna matematika')).toBe('2 days lateZadanie')
    expect((await card('Diskrétna matematika')).getAttribute('data-late')).toBe('true')
    // Due today is not overdue.
    expect((await card('Princípy počítačov')).getAttribute('data-late')).toBe('false')
    expect(CSS).toMatch(
      /\.class-card\[data-late='true'\] \{\s*border-left: 3px solid var\(--danger\);/,
    )
    expect(CSS).toMatch(
      /\.class-card\[data-late='true'\] \.class-card-slot \.meta \{\s*color: var\(--danger\);/,
    )
  })

  it('renders no standalone next-deadline card', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    await createDeadline({ title: 'Test', dueAt: dueIn(3), classId: discrete.id })
    await createDeadline({ title: 'Formulár', dueAt: dueIn(1) })
    show()

    await waitFor(async () => expect(await slot('Diskrétna matematika')).toBe('in 3 daysTest'))

    expect(screen.queryByRole('region', { name: 'Next deadline' })).toBeNull()
    expect(document.querySelector('.next-deadline')).toBeNull()
  })

  it('leaves out archived classes and their deadlines', async () => {
    await createClass({ name: 'Diskrétna matematika' })
    const old = await createClass({ name: 'Fyzika' })
    await createDeadline({ title: 'Skúška', dueAt: dueIn(4), classId: old.id })
    await archiveClass(old.id)
    show()

    await waitFor(async () => expect(await cards()).toHaveLength(1))

    expect((await region('Upcoming')).querySelectorAll('li')).toHaveLength(0)
  })

  it('opens the class a card belongs to', async () => {
    await createClass({ name: 'Diskrétna matematika' })
    const principles = await createClass({ name: 'Princípy počítačov' })
    const props = show()

    fireEvent.click(await waitFor(() => card('Princípy počítačov')))

    expect(props.onOpenClass).toHaveBeenCalledWith(principles.id)
  })

  it('ends the row with a New class card that creates a class', async () => {
    await createClass({ name: 'Diskrétna matematika' })
    const props = show()
    await waitFor(async () => expect(await cards()).toHaveLength(1))

    const items = within(await region('Classes')).getAllByRole('listitem')
    const last = items[items.length - 1]!
    fireEvent.click(within(last).getByRole('button', { name: '+ New class' }))
    const field = within(last).getByRole('textbox', { name: 'Class name' })
    fireEvent.change(field, { target: { value: '  Analýza  ' } })
    fireEvent.submit(field.closest('form')!)

    expect(props.onCreateClass).toHaveBeenCalledWith('Analýza')
  })
})

describe('Home recents', () => {
  it('interleaves notes and pages by recency, a page named by its book and number', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const general = (await listNotebooks(discrete.id))[0]!
    const book = await createCollegebook('Prednášky', discrete.id)
    const [first] = await listPages(book.id)
    const last = await createPage(book.id)
    // Order 1.5, so page 2 by position and not by its stored order.
    const middle = await insertPageAfter(first!.id)
    const relations = await createNote({ title: 'Relácie', notebookId: general.id })
    const functions = await createNote({ title: 'Funkcie', notebookId: general.id })
    const loose = await createNote({ title: 'Voľná' })
    const stamps: [string, number][] = [
      [last.id, 1],
      [relations.id, 2],
      [middle.id, 3],
      [loose.id, 4],
      [functions.id, 5],
      [first!.id, 6],
    ]
    for (const [id, hours] of stamps) {
      await db.notes.update(id, { updatedAt: hoursAgo(hours) })
    }
    const props = show()

    const list = await region('Pick up where you left off')
    await waitFor(() => expect(list.querySelectorAll('.home-name')).toHaveLength(4))

    expect([...list.querySelectorAll('.home-name')].map((node) => node.textContent)).toEqual([
      'Prednášky · p. 3',
      'Relácie',
      'Prednášky · p. 2',
      'Voľná',
    ])

    fireEvent.click(within(list).getByRole('button', { name: /^Prednášky · p. 2/ }))
    expect(props.onOpenPage).toHaveBeenCalledWith(book.id, middle.id)
    fireEvent.click(within(list).getByRole('button', { name: /^Relácie/ }))
    expect(props.onOpenNote).toHaveBeenCalledWith(relations.id)
    expect(props.onOpenClass).not.toHaveBeenCalled()
  })

  it('leaves the class name to the cards above', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    const general = (await listNotebooks(discrete.id))[0]!
    await createNote({ title: 'Relácie', notebookId: general.id })
    await createNote({ title: 'Voľná' })
    show()

    const list = await region('Pick up where you left off')
    await waitFor(() => expect(list.querySelectorAll('.home-name')).toHaveLength(2))

    expect(list.textContent).not.toContain('Diskrétna matematika')
    expect(list.textContent).not.toContain('—')
    expect(list.querySelector('.home-class')).toBeNull()
  })

  it('is absent on a fresh account', async () => {
    show()

    await region('Classes')

    expect(screen.queryByRole('region', { name: 'Pick up where you left off' })).toBeNull()
  })
})

describe('Home semester', () => {
  it('filters the cards and the deadlines, keeping unset and loose ones', async () => {
    const winter = await createClass({ name: 'Diskrétna matematika', semester: 'ZS 2026' })
    const summer = await createClass({ name: 'Matematická analýza', semester: 'LS 2026' })
    await createClass({ name: 'Princípy počítačov' })
    await createDeadline({ title: 'Písomka', dueAt: dueIn(3), classId: winter.id })
    await createDeadline({ title: 'Skúška', dueAt: dueIn(1), classId: summer.id })
    await createDeadline({ title: 'Formulár', dueAt: dueIn(20) })
    show()

    const select = await screen.findByRole('combobox', { name: 'Semester' })
    expect([...select.querySelectorAll('option')].map((node) => node.textContent)).toEqual([
      'All semesters',
      'LS 2026',
      'ZS 2026',
    ])
    await waitFor(async () => expect(await cards()).toHaveLength(3))

    fireEvent.change(select, { target: { value: 'ZS 2026' } })

    await waitFor(async () => expect(await cards()).toHaveLength(2))
    const names = (await cards()).map((node) => node.querySelector('.class-card-name')!.textContent)
    expect(names.sort()).toEqual(['Diskrétna matematika', 'Princípy počítačov'])
    expect((await upcomingRows()).map((row) => row[1])).toEqual(['Písomka', 'Formulár'])
  })

  it('is absent when no class has a semester', async () => {
    await createClass({ name: 'Diskrétna matematika' })
    show()

    await waitFor(async () => expect(await cards()).toHaveLength(1))

    expect(screen.queryByRole('combobox', { name: 'Semester' })).toBeNull()
  })
})

describe('Home upcoming', () => {
  it('lists every outstanding deadline, overdue first, with its class or an em-dash for a loose one', async () => {
    const discrete = await createClass({ name: 'Diskrétna matematika' })
    await createDeadline({ title: 'Formulár', dueAt: dueIn(20) })
    await createDeadline({ title: 'Písomka', dueAt: dueIn(3), classId: discrete.id })
    await createDeadline({ title: 'Zadanie', dueAt: dueIn(-2), classId: discrete.id })
    show()

    await waitFor(async () => expect(await upcomingRows()).toHaveLength(3))

    expect(await upcomingRows()).toEqual([
      ['2 days late', 'Zadanie', 'Diskrétna matematika'],
      ['in 3 days', 'Písomka', 'Diskrétna matematika'],
      ['in 20 days', 'Formulár', '—'],
    ])
    const late = (await region('Upcoming')).querySelector('li')!
    expect(late.getAttribute('data-late')).toBe('true')
  })

  it('opens the modal with no class preselected', async () => {
    await createClass({ name: 'Diskrétna matematika' })
    await createClass({ name: 'Princípy počítačov' })
    show()
    await waitFor(async () => expect(await cards()).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: '+ New deadline' }))

    const dialog = screen.getByRole('dialog', { name: 'New deadline' })
    const picker = within(dialog).getByRole('combobox', { name: 'Class' }) as HTMLSelectElement
    expect(picker.value).toBe('')
    expect([...picker.options].map((option) => option.textContent).sort()).toEqual([
      'Diskrétna matematika',
      'No class',
      'Princípy počítačov',
    ])
  })
})
