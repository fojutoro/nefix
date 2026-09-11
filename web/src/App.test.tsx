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
import App from './App.tsx'
import {
  archiveClass,
  createClass,
  deleteClass,
  writeLastClassId,
  writeLastWrittenClassId,
} from './db/classes.ts'
import { createNotebook, listNotebooks } from './db/notebooks.ts'
import { countNotes, createNote, deleteNote, listNotes } from './db/notes.ts'
import { db } from './db/schema.ts'
import i18n from './i18n/index.ts'
import { OfflineError } from './sync/api.ts'
import { login, logout, me } from './sync/auth.ts'
import { sync } from './sync/index.ts'

// The triggers are what the second block of tests is about, so sync itself is
// a spy: when it is called is the whole question, not what it does. hoisted,
// because vi.mock's factory runs before the module body.
const { idle, account } = vi.hoisted(() => ({
  account: {
    id: 1,
    username: 'jozef',
    display_name: 'Jozef Novák',
    email: 'jozef@example.sk',
    role: 'student' as const,
  },
  idle: () =>
    Promise.resolve({
      push: { pushed: 0, conflicted: 0, forbidden: 0, failed: 0 },
      pull: { applied: 0, skipped: 0, pages: 0 },
      changed: false,
    }),
}))

vi.mock('./sync/index.ts', () => ({ sync: vi.fn(idle) }))

// The wall stands in front of every test in this file, so auth is a mock and
// each suite says which of the three answers me() gives.
vi.mock('./sync/auth.ts', () => ({
  me: vi.fn(() => Promise.resolve(account)),
  login: vi.fn(() => Promise.resolve(account)),
  register: vi.fn(() => Promise.resolve(account)),
  logout: vi.fn(() => Promise.resolve()),
}))

function visibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

// setTimeout is deliberately left real, so this settles the promises the
// triggers started without advancing the clock the debounce reads.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

// jsdom has no ResizeObserver, and an editor that measures itself on mount
// throws without one. Nothing here tests the editor; this only keeps it from
// throwing when the new note selects itself.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver ??= NoopResizeObserver

describe('App', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await db.meta.clear()
    await i18n.changeLanguage('en')
    vi.mocked(me).mockResolvedValue(account)
    // sync is mocked for the whole file, so nothing here reaches the network
    // and every note stays dirty, which is what the assertions below expect.
    // The stub only catches anything the mock does not cover.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('writes a row to IndexedDB when a note is created through the UI', async () => {
    render(<App />)
    // With no classes and no notes this is the sentence about what a class
    // is, not the note-list empty state.
    await screen.findByText('A class is where the notes for one subject live.')
    expect(await countNotes()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))

    await waitFor(async () => expect(await countNotes()).toBe(1))
    const [note] = await listNotes()
    expect(note).toMatchObject({ bodyMd: '', deletedAt: null, dirty: true })
    // Creating a note opens it. There is no list left to land in.
    await waitFor(() => expect(editor()).not.toBeNull())
    // Selecting it remembers it, which is what a reload reads back.
    await waitFor(async () =>
      expect((await db.meta.get('lastNoteId'))?.value).toBe(note!.id),
    )
  })

  it('finds a diacritic title from an unaccented query typed into the box', async () => {
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# množiny' })
    await createNote({ title: 'Lineárna algebra', bodyMd: 'vektory' })
    render(<App />)
    await waitFor(() => expect(noteRows()).toHaveLength(2))

    const box = screen.getByRole('searchbox', { name: 'Search notes' })
    fireEvent.change(box, { target: { value: 'diskretna' } })

    await screen.findByText('1 match')
    screen.getByRole('button', { name: /^Diskrétna matematika/ })
    expect(screen.queryByRole('button', { name: /^Lineárna/ })).toBeNull()

    fireEvent.change(box, { target: { value: 'diskretna fyzika' } })

    await screen.findByText('No notes match your search.')
    await screen.findByText('0 matches')

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    await waitFor(() => expect(noteRows()).toHaveLength(2))
  })
})

describe('App sync triggers', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await db.meta.clear()
    await i18n.changeLanguage('en')
    vi.mocked(me).mockResolvedValue(account)
    vi.mocked(sync).mockReset()
    vi.mocked(sync).mockImplementation(idle)
    visibility('visible')
    // Date is faked alongside the interval because the debounce reads
    // Date.now(): advancing only the timer would leave every tick inside the
    // two-second window and debounced out of existence. setTimeout stays real
    // so Dexie and fake-indexeddb still resolve.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('keeps firing the interval while the tab is visible', async () => {
    render(<App />)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))

    vi.advanceTimersByTime(10_000)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    vi.advanceTimersByTime(10_000)

    // More than once: an interval cleared before it fires looks identical to
    // a working one if only the first tick is asserted.
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(3))
  })

  it('does not fire the interval while the tab is hidden', async () => {
    render(<App />)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))

    // Past the debounce, so the flush on hiding is not swallowed by it.
    vi.advanceTimersByTime(2_100)
    visibility('hidden')
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2))

    vi.advanceTimersByTime(60_000)
    await settle()

    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('syncs when the window is focused', async () => {
    render(<App />)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))

    vi.advanceTimersByTime(2_100)
    window.dispatchEvent(new Event('focus'))

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
  })

  it('collapses two triggers inside two seconds into one sync', async () => {
    render(<App />)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))
    vi.advanceTimersByTime(2_100)

    // What switching to this window actually produces: both events, back to
    // back, for one thing the user did.
    window.dispatchEvent(new Event('focus'))
    visibility('visible')
    await settle()

    expect(sync).toHaveBeenCalledTimes(2)
  })
})

describe('App remembering the open note', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await db.meta.clear()
    await i18n.changeLanguage('en')
    vi.mocked(me).mockResolvedValue(account)
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('reopens the note that was open when the page was last closed', async () => {
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# Množiny' })
    const wanted = await createNote({
      title: 'Lineárna algebra',
      bodyMd: 'vektory',
    })
    await db.meta.put({ key: 'lastNoteId', value: wanted.id })

    render(<App />)

    // The editor is open on it, and the grid it came from is gone.
    await screen.findByText('vektory')
    expect(screen.queryByRole('list', { name: 'Notes' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Diskrétna/ })).toBeNull()
  })

  it('falls back to the empty state when the remembered note was deleted', async () => {
    const note = await createNote({ title: 'Zmazaná', bodyMd: 'text' })
    await deleteNote(note.id)
    await db.meta.put({ key: 'lastNoteId', value: note.id })

    render(<App />)

    await screen.findByText('A class is where the notes for one subject live.')
  })

  it('falls back to the empty state when the remembered id is not in the database', async () => {
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# Množiny' })
    await db.meta.put({ key: 'lastNoteId', value: 'no-such-note' })

    render(<App />)

    // The grid, not an editor: a remembered id that names nothing may not
    // open anything.
    await waitFor(() => expect(noteRows()).toHaveLength(1))
    screen.getByRole('button', { name: /^Diskrétna/ })
    expect(editor()).toBeNull()
  })
})

describe('App auth wall', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await db.classes.clear()
    await db.notebooks.clear()
    await db.meta.clear()
    await i18n.changeLanguage('en')
    // Call history only, not the implementations set below: one test's sign
    // in would otherwise count as the next one's.
    vi.clearAllMocks()
    vi.mocked(me).mockResolvedValue(account)
    vi.mocked(login).mockResolvedValue(account)
    vi.mocked(logout).mockResolvedValue(undefined)
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const signIn = async () => {
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'jozef@example.sk' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'hunter2hunter2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  }

  it('renders the auth screen when me() answers 401', async () => {
    vi.mocked(me).mockResolvedValue(null)

    render(<App />)

    await screen.findByRole('button', { name: 'Sign in' })
    expect(screen.queryByRole('button', { name: 'New note' })).toBeNull()
  })

  it('renders the app after signing in with valid credentials', async () => {
    vi.mocked(me).mockResolvedValue(null)
    render(<App />)
    await screen.findByRole('button', { name: 'Sign in' })

    await signIn()

    await screen.findByRole('button', { name: 'New note' })
    expect(login).toHaveBeenCalledWith('jozef@example.sk', 'hunter2hunter2')
  })

  it('renders the app when me() fails on the network and notes are held locally', async () => {
    // Someone opening the app on a train: the session cookie is valid, the
    // notes are on the device, and only the server is out of reach. A login
    // screen here would contradict the whole offline-first premise.
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# Množiny' })
    vi.mocked(me).mockRejectedValue(new OfflineError('network unreachable'))

    render(<App />)

    await screen.findByRole('button', { name: 'New note' })
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('shows the wall when me() fails on the network with nothing stored', async () => {
    // The other half of the same rule: with no notes there is nothing to
    // show, so an unreachable server is not a reason to skip the wall.
    vi.mocked(me).mockRejectedValue(new OfflineError('network unreachable'))

    render(<App />)

    await screen.findByRole('button', { name: 'Sign in' })
  })

  it('clears IndexedDB when signing out', async () => {
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# Množiny' })
    await db.meta.put({ key: 'syncCursor', value: 42 })
    render(<App />)
    await screen.findByRole('button', { name: 'New note' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(async () => expect(await db.notes.count()).toBe(0))
    // The cursor and the remembered note go too: one left behind would tell
    // the next account's pull it is already caught up.
    expect(await db.meta.count()).toBe(0)
    expect(logout).toHaveBeenCalled()
    await screen.findByRole('button', { name: 'Sign in' })
  })

  it('names the number of unsynced notes when signing out', async () => {
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# Množiny' })
    await createNote({ title: 'Lineárna algebra', bodyMd: 'vektory' })
    render(<App />)
    await screen.findByRole('button', { name: 'New note' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toBe(
      '2 changes have not synced yet and will be lost. Sign out anyway?',
    )
  })

  it('warns about an unsynced notebook when no note is unsynced', async () => {
    await createNotebook('Cvičenia')
    expect(await db.notes.count()).toBe(0)

    render(<App />)
    await screen.findByRole('button', { name: 'New note' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    // Counting notes alone, this reads as nothing to lose, and the notebook
    // is then deleted by a confirmation that promised it was not there.
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toBe(
      '1 change has not synced yet and will be lost. Sign out anyway?',
    )
  })

  it('rejects a short password without reaching the server', async () => {
    vi.mocked(me).mockResolvedValue(null)
    render(<App />)
    await screen.findByRole('button', { name: 'Sign in' })

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'jozef@example.sk' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'short' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await screen.findByText('Password must be 8 to 128 bytes.')
    expect(login).not.toHaveBeenCalled()
  })
})

// Local midnight is the boundary Today is drawn at, so the fixtures are
// stamped either side of it rather than at an age in hours: at 00:30 a note
// two hours old is yesterday's, and a test that assumed otherwise would fail
// only for whoever runs it at the wrong time of night.
const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()
const afterMidnight = () => new Date(startOfToday() + 1000).toISOString()
const beforeMidnight = () => new Date(startOfToday() - 1000).toISOString()
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

// updatedAt is written directly because createNote stamps now(), and the
// rail's whole order is that field.
async function seedClass(
  name: string,
  notes: [title: string, updatedAt: string][] = [],
  code?: string,
) {
  const created = await createClass({ name, code })
  const notebook = (await listNotebooks(created.id))[0]!
  for (const [title, updatedAt] of notes) {
    const note = await createNote({ title, notebookId: notebook.id })
    await db.notes.update(note.id, { updatedAt })
  }
  return created
}

// The list's last row is "New note", which is not a note.
const noteRows = () =>
  within(screen.getByRole('list', { name: 'Notes' }))
    .getAllByRole('listitem')
    .slice(0, -1)

// TipTap's editable node, which is what `.editor` now holds.
const editor = () => document.querySelector('.tiptap')

const railRows = () =>
  within(screen.getByRole('navigation', { name: 'Classes' }))
    .getAllByRole('listitem')
    .map((row) => row.textContent)

describe('App class rail', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await db.classes.clear()
    await db.notebooks.clear()
    await db.meta.clear()
    await i18n.changeLanguage('en')
    vi.mocked(me).mockResolvedValue(account)
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('orders the classes by their most recent note, not by name', async () => {
    // The two orders disagree. Alphabetically: Analýza, Diskrétna, Lineárna,
    // Zoológia. By recency: Diskrétna, Lineárna, Analýza, then the class
    // that has never been written in.
    await seedClass('Analýza', [['Miera', ago(21 * 86_400_000)]])
    await seedClass('Diskrétna matematika', [['Množiny', ago(2 * 3_600_000)]])
    await seedClass('Lineárna algebra', [['Vektory', ago(2 * 86_400_000)]])
    await seedClass('Zoológia')
    render(<App />)

    await waitFor(() => expect(railRows()).toHaveLength(5))

    expect(railRows()).toEqual([
      'Today',
      'Diskrétna matematika2h ago',
      'Lineárna algebra2d ago',
      'Analýza3w ago',
      // Present, and with nothing in the recency column: a class with no
      // notes still has to be reachable.
      'Zoológia',
    ])
  })

  it('filters the note list to the class that was clicked', async () => {
    await seedClass(
      'Diskrétna matematika',
      [['Množiny', afterMidnight()]],
      '1-AIN-121',
    )
    await seedClass('Lineárna algebra', [['Vektory', afterMidnight()]])
    render(<App />)
    await waitFor(() => expect(noteRows()).toHaveLength(2))

    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )

    await waitFor(() => expect(noteRows()).toHaveLength(1))
    screen.getByRole('button', { name: /^Množiny/ })
    expect(screen.queryByRole('button', { name: /^Vektory/ })).toBeNull()
    // The header names the class, with the code beside it.
    screen.getByRole('heading', { name: 'Diskrétna matematika' })
    screen.getByText('1-AIN-121')
  })

  it('shows Today across classes and nothing from before midnight', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    await seedClass('Lineárna algebra', [
      ['Vektory', afterMidnight()],
      ['Staré vektory', beforeMidnight()],
    ])
    render(<App />)

    await waitFor(() => expect(noteRows()).toHaveLength(2))

    screen.getByRole('heading', { name: 'Today' })
    screen.getByRole('button', { name: /^Množiny/ })
    screen.getByRole('button', { name: /^Vektory/ })
    expect(screen.queryByRole('button', { name: /^Staré vektory/ })).toBeNull()
  })

  it('hides Unfiled at zero and shows it with its count', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    const first = render(<App />)
    await waitFor(() => expect(railRows()).toHaveLength(2))
    expect(
      within(screen.getByRole('navigation', { name: 'Classes' })).queryByRole(
        'button',
        { name: /Unfiled/ },
      ),
    ).toBeNull()
    first.unmount()

    await createNote({ title: 'Nezaradená' })
    render(<App />)

    const rail = await screen.findByRole('navigation', { name: 'Classes' })
    const row = await waitFor(() =>
      within(rail).getByRole('button', { name: /^Unfiled/ }),
    )
    expect(row.textContent).toBe('Unfiled1')
  })

  it('marks every kind of rail row with a decorative icon', async () => {
    const old = await seedClass('Fyzika', [['Sila', beforeMidnight()]])
    await archiveClass(old.id)
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    await createNote({ title: 'Nezaradená' })
    render(<App />)

    const rail = await screen.findByRole('navigation', { name: 'Classes' })
    await waitFor(() => within(rail).getByRole('button', { name: 'Archived' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Archived' }))

    const icon = (name: string | RegExp) =>
      within(rail).getByRole('button', { name }).querySelector('.rail-icon')
        ?.innerHTML

    const marks = ['Today', /^Unfiled/, /^Diskrétna/, 'Archived'].map(icon)
    expect(marks.every((mark) => mark !== undefined && mark !== '')).toBe(true)
    // Four kinds of row, four different icons. Presence alone would pass with
    // the same one wired to all of them.
    expect(new Set(marks).size).toBe(4)
    // An archived class is still a class, and reads as one.
    expect(icon(/^Fyzika/)).toBe(icon(/^Diskrétna/))

    // The icons are aria-hidden, so the names the rest of this suite matches
    // on are the names they were.
    expect(
      within(rail).getByRole('button', { name: 'Today' }).textContent,
    ).toBe('Today')
    expect(
      within(rail).getByRole('button', { name: /^Unfiled/ }).textContent,
    ).toBe('Unfiled1')
  })

  it('creates a class and its general notebook from the inline row, and selects it', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '+ New class' }))
    const field = screen.getByRole('textbox', { name: 'Class name' })
    fireEvent.change(field, { target: { value: 'Diskrétna matematika' } })
    fireEvent.submit(field.closest('form')!)

    await waitFor(async () => expect(await db.classes.count()).toBe(1))
    const [created] = await db.classes.toArray()
    // A class you cannot type in is the failure this pairing rules out.
    const notebooks = await db.notebooks.toArray()
    expect(notebooks).toHaveLength(1)
    expect(notebooks[0]).toMatchObject({
      classId: created!.id,
      isGeneral: true,
    })
    await screen.findByRole('heading', { name: 'Diskrétna matematika' })
    const row = screen.getByRole('button', { name: 'Diskrétna matematika' })
    await waitFor(() => expect(row.getAttribute('aria-current')).toBe('true'))
  })

  it('cancels the inline row on Escape and does nothing with an empty name', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '+ New class' }))
    const field = screen.getByRole('textbox', { name: 'Class name' })

    fireEvent.submit(field.closest('form')!)
    await settle()
    expect(await db.classes.count()).toBe(0)

    fireEvent.change(field, { target: { value: 'Diskrétna' } })
    fireEvent.keyDown(field, { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'Class name' })).toBeNull()
    await settle()
    expect(await db.classes.count()).toBe(0)
  })

  it('creates a note in the selected class when n is pressed', async () => {
    const discrete = await seedClass('Diskrétna matematika', [
      ['Množiny', afterMidnight()],
    ])
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )
    await waitFor(() => expect(noteRows()).toHaveLength(1))

    fireEvent.keyDown(window, { key: 'n' })

    const notebook = (await listNotebooks(discrete.id))[0]!
    await waitFor(async () =>
      expect(await listNotes(notebook.id)).toHaveLength(2),
    )
    // The new note is open, with the cursor in it.
    await waitFor(() => expect(editor()).not.toBeNull())
    // The editor defers taking focus to an animation frame, so the cursor
    // arrives a tick after the editor does.
    await waitFor(() =>
      expect(document.activeElement?.closest('.editor')).not.toBeNull(),
    )
  })

  it('does not create a note when n is typed inside the editor', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Množiny/ }))
    const content = await waitFor(() => {
      const found = editor()
      if (found === null) throw new Error('the editor has not mounted')
      return found
    })
    expect(await countNotes()).toBe(1)

    fireEvent.keyDown(content, { key: 'n' })
    await settle()

    // Getting this wrong means typing the letter n in a note creates a note,
    // which makes the shortcut unusable.
    expect(await countNotes()).toBe(1)

    // The search box is the other editable surface. It lives on the class
    // page, so leaving the editor is what brings it back.
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search notes' }), {
      key: 'n',
    })
    await settle()

    expect(await countNotes()).toBe(1)
  })

  it('writes into the last class written in when Today is selected', async () => {
    const discrete = await seedClass('Diskrétna matematika', [
      ['Množiny', afterMidnight()],
    ])
    await writeLastWrittenClassId(discrete.id)
    render(<App />)
    await screen.findByRole('heading', { name: 'Today' })

    fireEvent.keyDown(window, { key: 'n' })

    const notebook = (await listNotebooks(discrete.id))[0]!
    await waitFor(async () =>
      expect(await listNotes(notebook.id)).toHaveLength(2),
    )
  })

  it('writes an unfiled note when no class has been written in yet', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Today' })

    fireEvent.keyDown(window, { key: 'n' })

    await waitFor(async () => expect(await listNotes(null)).toHaveLength(1))
  })

  it('restores the remembered class on mount', async () => {
    const discrete = await seedClass('Diskrétna matematika', [
      // Before midnight, so a list showing it proves the class was restored
      // and not that Today happens to contain the same note.
      ['Množiny', beforeMidnight()],
    ])
    await seedClass('Lineárna algebra', [['Vektory', afterMidnight()]])
    await writeLastClassId(discrete.id)

    render(<App />)

    await screen.findByRole('heading', { name: 'Diskrétna matematika' })
    await screen.findByRole('button', { name: /^Množiny/ })
    expect(screen.queryByRole('button', { name: /^Vektory/ })).toBeNull()
  })

  it('falls back to Today when the remembered class was deleted', async () => {
    const gone = await seedClass('Zmazaný')
    await writeLastClassId(gone.id)
    await deleteClass(gone.id)
    await seedClass('Lineárna algebra', [['Vektory', afterMidnight()]])

    render(<App />)

    await screen.findByRole('heading', { name: 'Today' })
    await screen.findByRole('button', { name: /^Vektory/ })
  })

  it('falls back to Today when the remembered class was archived', async () => {
    const old = await seedClass('Fyzika', [['Sila', beforeMidnight()]])
    await writeLastClassId(old.id)
    await archiveClass(old.id)

    render(<App />)

    await screen.findByRole('heading', { name: 'Today' })
    // Archived is not deleted: the class stays reachable from the rail.
    const rail = screen.getByRole('navigation', { name: 'Classes' })
    await waitFor(() => within(rail).getByRole('button', { name: 'Archived' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Archived' }))
    fireEvent.click(within(rail).getByRole('button', { name: /^Fyzika/ }))
    await screen.findByRole('heading', { name: 'Fyzika' })
    await screen.findByRole('button', { name: /^Sila/ })
  })

  it('opens the rail as a drawer and closes it on Escape and on a choice', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    render(<App />)
    const toggle = await screen.findByRole('button', { name: 'Classes' })
    const app = document.querySelector('.app')!
    expect(app.getAttribute('data-rail-open')).toBe('false')

    fireEvent.click(toggle)
    expect(app.getAttribute('data-rail-open')).toBe('true')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(app.getAttribute('data-rail-open')).toBe('false')

    fireEvent.click(toggle)
    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )

    expect(app.getAttribute('data-rail-open')).toBe('false')
  })

  it('says what a class is when there are none, and offers the same row', async () => {
    render(<App />)

    await screen.findByText('A class is where the notes for one subject live.')
    fireEvent.click(
      screen.getByRole('button', { name: 'Add the first class' }),
    )

    screen.getByRole('textbox', { name: 'Class name' })
  })

  it('invites a note in a class that has none, and stays quiet in an empty Today', async () => {
    await seedClass('Diskrétna matematika')
    render(<App />)

    await screen.findByText('Nothing yet today')

    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )

    // The invitation is the first card in the grid, not a line of prose.
    await waitFor(() => expect(noteRows()).toHaveLength(0))
    screen.getByRole('button', { name: 'New note' })
    await screen.findByText('Nothing here yet')
  })
})

describe('App two panes', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await db.classes.clear()
    await db.notebooks.clear()
    await db.meta.clear()
    await i18n.changeLanguage('en')
    vi.mocked(me).mockResolvedValue(account)
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the class page and not the editor when a class is selected', async () => {
    // Three weeks written in, because a strip is absent below that: one mark
    // among thirteen blanks is not a record of a semester.
    await seedClass('Diskrétna matematika', [
      ['Množiny', afterMidnight()],
      ['Relácie', ago(9 * 86_400_000)],
      ['Funkcie', ago(20 * 86_400_000)],
    ])
    render(<App />)

    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )

    await screen.findByRole('heading', { name: 'Diskrétna matematika' })
    // The strip is the reason the page exists, so its absence here would
    // mean the page is still just a list with a title. Awaited, because the
    // heading paints a frame before the read behind it lands.
    await screen.findByRole('list', { name: 'Weeks written in' })
    expect(noteRows()).toHaveLength(3)
    expect(editor()).toBeNull()
  })

  it('opens the editor on a card and returns to the class page on Escape', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )
    await screen.findByRole('heading', { name: 'Diskrétna matematika' })

    fireEvent.click(screen.getByRole('button', { name: /^Množiny/ }))

    await waitFor(() => expect(editor()).not.toBeNull())
    expect(screen.queryByRole('list', { name: 'Notes' })).toBeNull()
    // The class it belongs to is named at the top, muted and small, and it
    // is the way back.
    screen.getByRole('button', { name: 'Back to Diskrétna matematika' })

    fireEvent.keyDown(window, { key: 'Escape' })

    await screen.findByRole('heading', { name: 'Diskrétna matematika' })
    expect(editor()).toBeNull()
  })

  it('returns to the class page with the back button', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Množiny/ }))
    await waitFor(() => expect(editor()).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /^Back to/ }))

    await waitFor(() => expect(editor()).toBeNull())
    expect(noteRows()).toHaveLength(1)
  })

  it('leaves out the strip for a class with no notes', async () => {
    await seedClass('Zoológia')
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Zoológia' }))

    await screen.findByRole('heading', { name: 'Zoológia' })
    expect(screen.queryByRole('list', { name: 'Weeks written in' })).toBeNull()
  })


  it('resizes the rail and remembers the width', async () => {
    render(<App />)
    const handle = await screen.findByRole('separator')
    const app = document.querySelector('.app')!

    fireEvent.mouseDown(handle, { clientX: 240 })
    fireEvent.mouseMove(window, { clientX: 300 })
    fireEvent.mouseUp(window, { clientX: 300 })

    expect(app.getAttribute('style')).toContain('300px')
    await waitFor(async () =>
      expect((await db.meta.get('railWidth'))?.value).toBe(300),
    )
  })

  it('clamps the rail to its range and resets it on a double click', async () => {
    await db.meta.put({ key: 'railWidth', value: 320 })
    render(<App />)
    const handle = await screen.findByRole('separator')
    const app = document.querySelector('.app')!
    await waitFor(() => expect(app.getAttribute('style')).toContain('320px'))

    fireEvent.mouseDown(handle, { clientX: 320 })
    fireEvent.mouseMove(window, { clientX: 900 })
    fireEvent.mouseUp(window, { clientX: 900 })

    expect(app.getAttribute('style')).toContain('360px')

    fireEvent.doubleClick(handle)

    expect(app.getAttribute('style')).toContain('240px')
    await waitFor(async () =>
      expect((await db.meta.get('railWidth'))?.value).toBe(240),
    )
  })

  it('creates a note with n from the class page and from Today', async () => {
    const discrete = await seedClass('Diskrétna matematika', [
      ['Množiny', afterMidnight()],
    ])
    render(<App />)
    await screen.findByRole('heading', { name: 'Today' })

    // From Today, which is not a place to write. Nothing has been written in
    // yet, so the note is unfiled — and it still opens.
    fireEvent.keyDown(window, { key: 'n' })
    await waitFor(async () => expect(await listNotes(null)).toHaveLength(1))
    await waitFor(() => expect(editor()).not.toBeNull())

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )
    await screen.findByRole('heading', { name: 'Diskrétna matematika' })

    fireEvent.keyDown(window, { key: 'n' })

    const notebook = (await listNotebooks(discrete.id))[0]!
    await waitFor(async () =>
      expect(await listNotes(notebook.id)).toHaveLength(2),
    )
    // And from the rail, which is where the third state is.
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Today' }), {
      key: 'n',
    })
    await waitFor(async () =>
      expect(await listNotes(notebook.id)).toHaveLength(3),
    )
  })

  it('nudges about an idle class and stays quiet about a fresh one', async () => {
    await seedClass('Analýza', [['Miera', ago(21 * 86_400_000)]])
    await seedClass('Diskrétna matematika', [['Množiny', ago(5 * 60_000)]])
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^Analýza/ }))

    // A duration, not a timestamp: this is the line that gets a neglected
    // class opened.
    await screen.findByText('Nothing here for 3 weeks')

    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )
    await screen.findByRole('heading', { name: 'Diskrétna matematika' })

    // Five minutes is not a gap worth naming, and "nothing here for 0 days"
    // would be worse than saying nothing. Awaited, because the heading
    // repaints a frame before the read behind it lands.
    await waitFor(() => expect(document.querySelector('.state')).toBeNull())
  })

  it('says when a class was last written in, in the case Slovak needs', async () => {
    await i18n.changeLanguage('sk')
    await seedClass('Diskrétna matematika', [['Množiny', ago(3 * 86_400_000)]])
    render(<App />)

    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )

    // "pred" takes the instrumental, so the number and its unit have to come
    // from the formatter that knows that: pred 3 dňami, never pred 3 dni.
    await screen.findByText('Naposledy pred 3 dňami')
  })

  it('deletes a note from its row, once', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /^Diskrétna matematika/ }),
    )
    await waitFor(() => expect(noteRows()).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Delete Množiny' }))

    await waitFor(() => expect(noteRows()).toHaveLength(0))
    expect(window.confirm).toHaveBeenCalled()
    expect(await countNotes()).toBe(0)
  })
})

describe('App class controls', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await db.classes.clear()
    await db.notebooks.clear()
    await db.meta.clear()
    await i18n.changeLanguage('en')
    vi.mocked(me).mockResolvedValue(account)
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const openClass = async (name = 'Diskrétna matematika') => {
    fireEvent.click(await screen.findByRole('button', { name: RegExp(`^${name}`) }))
    return screen.findByRole('heading', { name })
  }

  const railRow = (name: string) =>
    within(screen.getByRole('navigation', { name: 'Classes' })).getByRole(
      'button',
      { name: RegExp(`^${name}`) },
    )

  it('renames the class inline from its heading', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    render(<App />)
    const heading = await openClass()

    fireEvent.click(within(heading).getByRole('button'))
    const field = screen.getByRole('textbox', { name: 'Rename class' })
    fireEvent.change(field, { target: { value: 'Diskrétna matematika II' } })
    fireEvent.submit(field.closest('form')!)

    await screen.findByRole('heading', { name: 'Diskrétna matematika II' })
    await waitFor(async () =>
      expect((await db.classes.toArray())[0]!.name).toBe(
        'Diskrétna matematika II',
      ),
    )
    // And the rail, which is the other place the name is.
    railRow('Diskrétna matematika II')
  })

  it('leaves the name alone when the inline edit is cancelled or emptied', async () => {
    await seedClass('Diskrétna matematika')
    render(<App />)
    const heading = await openClass()

    fireEvent.click(within(heading).getByRole('button'))
    const field = screen.getByRole('textbox', { name: 'Rename class' })
    fireEvent.change(field, { target: { value: 'Zmena' } })
    fireEvent.keyDown(field, { key: 'Escape' })

    await screen.findByRole('heading', { name: 'Diskrétna matematika' })

    fireEvent.click(
      within(screen.getByRole('heading', { name: 'Diskrétna matematika' })).getByRole(
        'button',
      ),
    )
    const again = screen.getByRole('textbox', { name: 'Rename class' })
    fireEvent.change(again, { target: { value: '   ' } })
    fireEvent.submit(again.closest('form')!)

    // A class has to be called something, so an empty name does nothing.
    await settle()
    expect((await db.classes.toArray())[0]!.name).toBe('Diskrétna matematika')
  })

  it('sets the code inline, from absent to set', async () => {
    await seedClass('Diskrétna matematika')
    render(<App />)
    await openClass()

    fireEvent.click(screen.getByRole('button', { name: 'Add code' }))
    const field = screen.getByRole('textbox', { name: 'Course code' })
    fireEvent.change(field, { target: { value: '1-AIN-121' } })
    fireEvent.submit(field.closest('form')!)

    await screen.findByText('1-AIN-121')
    await waitFor(async () =>
      expect((await db.classes.toArray())[0]!.code).toBe('1-AIN-121'),
    )
  })

  it('opens the menu and closes it on Escape and on a click outside', async () => {
    await seedClass('Diskrétna matematika')
    render(<App />)
    await openClass()

    fireEvent.click(screen.getByRole('button', { name: 'Class actions' }))
    screen.getByRole('button', { name: 'Archive' })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Class actions' }))
    screen.getByRole('button', { name: 'Archive' })
    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
  })

  it('sets a colour, and the rail spine takes it', async () => {
    await seedClass('Diskrétna matematika')
    render(<App />)
    await openClass()
    expect(railRow('Diskrétna').getAttribute('style')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Class actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Colour 2' }))

    const colour = await waitFor(async () => {
      const set = (await db.classes.toArray())[0]!.colour
      if (set === null) throw new Error('the colour has not been written')
      return set
    })
    await waitFor(() =>
      expect(railRow('Diskrétna').getAttribute('style')).toContain(colour),
    )
  })

  it('sets a semester from the menu', async () => {
    await seedClass('Diskrétna matematika')
    render(<App />)
    await openClass()

    fireEvent.click(screen.getByRole('button', { name: 'Class actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add semester' }))
    const field = screen.getByRole('textbox', { name: 'Semester' })
    fireEvent.change(field, { target: { value: 'ZS 2026' } })
    fireEvent.submit(field.closest('form')!)

    await waitFor(async () =>
      expect((await db.classes.toArray())[0]!.semester).toBe('ZS 2026'),
    )
  })

  it('archives after confirming and returns to Today', async () => {
    await seedClass('Diskrétna matematika', [['Množiny', afterMidnight()]])
    render(<App />)
    await openClass()

    fireEvent.click(screen.getByRole('button', { name: 'Class actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

    await screen.findByRole('heading', { name: 'Today' })
    expect(window.confirm).toHaveBeenCalled()
    await waitFor(async () =>
      expect((await db.classes.toArray())[0]!.archivedAt).not.toBeNull(),
    )
    // Archiving is the gentle option: the notes are all still there.
    expect(await countNotes()).toBe(1)
  })

  it('deletes the class, its notebooks and its notes, counted at the moment of asking', async () => {
    const discrete = await seedClass('Diskrétna matematika', [
      ['Množiny', afterMidnight()],
    ])
    render(<App />)
    await openClass()
    await waitFor(() => expect(noteRows()).toHaveLength(1))

    // Written after the page loaded, so the count on screen is one and the
    // truth is two. A dialog that says "and its 1 note" here has lied to get
    // the answer it wanted.
    const notebook = (await listNotebooks(discrete.id))[0]!
    await createNote({ title: 'Relácie', notebookId: notebook.id })

    fireEvent.click(screen.getByRole('button', { name: 'Class actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toBe(
      'Delete Diskrétna matematika and its 2 notes? This cannot be undone.',
    )

    await screen.findByRole('heading', { name: 'Today' })
    // All three tables, soft and dirty: notes left behind would be invisible
    // here and would come back on the next pull.
    await waitFor(async () => {
      expect(await db.classes.get(discrete.id)).toMatchObject({
        dirty: true,
      })
      expect((await db.classes.get(discrete.id))!.deletedAt).not.toBeNull()
    })
    for (const notebook of await db.notebooks.toArray()) {
      expect(notebook.deletedAt).not.toBeNull()
      expect(notebook.dirty).toBe(true)
    }
    for (const note of await db.notes.toArray()) {
      expect(note.deletedAt).not.toBeNull()
      expect(note.dirty).toBe(true)
    }
    expect(await countNotes()).toBe(0)
  })

  it('names no count when deleting a class that has no notes', async () => {
    await seedClass('Zoológia')
    render(<App />)
    await openClass('Zoológia')

    fireEvent.click(screen.getByRole('button', { name: 'Class actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toBe(
      'Delete Zoológia? This cannot be undone.',
    )
  })

})

describe('App table of contents', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await db.classes.clear()
    await db.notebooks.clear()
    await db.meta.clear()
    await i18n.changeLanguage('en')
    vi.mocked(me).mockResolvedValue(account)
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const write = async (classId: string, title: string, bodyMd: string, at: string) => {
    const notebook = (await listNotebooks(classId))[0]!
    const note = await createNote({ title, bodyMd, notebookId: notebook.id })
    await db.notes.update(note.id, { updatedAt: at })
    return note
  }

  // The count is waited for, not the heading: the heading paints a frame
  // before the read behind it lands, and until then the rows on screen still
  // belong to the shelf that was open before.
  const open = async (rows: number, name = 'Diskrétna matematika') => {
    fireEvent.click(await screen.findByRole('button', { name: RegExp(`^${name}`) }))
    await screen.findByRole('heading', { name })
    return waitFor(() => {
      const found = noteRows()
      if (found.length !== rows) throw new Error(`${found.length} rows, not ${rows}`)
      return found
    })
  }

  it('lists the notes newest first, with the date in its own column', async () => {
    const cls = await seedClass('Diskrétna matematika')
    await write(cls.id, 'Úvod do logiky', 'Úvod do logiky', '2026-09-05T09:00:00.000Z')
    await write(cls.id, 'Množiny', 'Množiny', '2026-09-08T09:00:00.000Z')
    await write(cls.id, 'Organizačné', 'Organizačné', '2026-08-29T09:00:00.000Z')
    render(<App />)

    const rows = await open(3)

    expect(rows.map((row) => row.querySelector('time')?.textContent)).toEqual([
      'Sep 8',
      'Sep 5',
      'Aug 29',
    ])
    expect(
      rows.map((row) => row.querySelector('.toc-title')?.textContent),
    ).toEqual(['Množiny', 'Úvod do logiky', 'Organizačné'])
  })

  it("shows a note's headings under its title", async () => {
    const cls = await seedClass('Diskrétna matematika')
    await write(
      cls.id,
      'Množiny a relácie',
      '# Množiny a relácie\n## Definícia množiny\ntext\n## Operácie\n### Karteziánsky súčin',
      afterMidnight(),
    )
    render(<App />)

    const [row] = await open(1)

    // The structure of the note is what it was about, and it is already in
    // the markdown.
    within(row!).getByText(
      'Definícia množiny · Operácie · Karteziánsky súčin',
    )
  })

  it('shows the title alone for a note with no headings', async () => {
    const cls = await seedClass('Diskrétna matematika')
    await write(
      cls.id,
      'Organizačné',
      'Organizačné\nStretnutie v utorok.',
      afterMidnight(),
    )
    render(<App />)

    const [row] = await open(1)

    within(row!).getByText('Organizačné')
    // Not a placeholder and not an em dash: nothing at all.
    expect(row!.querySelector('.toc-outline')).toBeNull()
  })

  it('counts the headings past the sixth', async () => {
    const cls = await seedClass('Diskrétna matematika')
    const body = ['Množiny', ...Array.from({ length: 9 }, (_, n) => `## H${n + 1}`)]
    await write(cls.id, 'Množiny', body.join('\n'), afterMidnight())
    render(<App />)

    const [row] = await open(1)

    within(row!).getByText(
      'H1 · H2 · H3 · H4 · H5 · H6 · +3 more',
    )
  })

  it('creates a note from the row at the bottom of the list', async () => {
    const cls = await seedClass('Diskrétna matematika')
    await write(cls.id, 'Množiny', 'Množiny', afterMidnight())
    render(<App />)
    await open(1)

    const all = within(screen.getByRole('list', { name: 'Notes' })).getAllByRole(
      'listitem',
    )
    // Last, in the rhythm of the list rather than competing with it.
    within(all[all.length - 1]!).getByRole('button', { name: 'New note' })
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))

    const notebook = (await listNotebooks(cls.id))[0]!
    await waitFor(async () =>
      expect(await listNotes(notebook.id)).toHaveLength(2),
    )
  })

  it('deletes a note from its row after confirming', async () => {
    const cls = await seedClass('Diskrétna matematika')
    await write(cls.id, 'Množiny', 'Množiny', afterMidnight())
    render(<App />)
    await open(1)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Množiny' }))

    await waitFor(() => expect(noteRows()).toHaveLength(0))
    expect(window.confirm).toHaveBeenCalled()
    expect(await countNotes()).toBe(0)
  })
})
