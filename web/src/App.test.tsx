import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { createNotebook } from './db/notebooks.ts'
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

// CodeMirror measures itself once it mounts, and jsdom has no
// ResizeObserver. Nothing here tests CodeMirror; this only keeps the editor
// from throwing when the new note selects itself.
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
    await screen.findByText('No notes yet. Create one to start writing.')
    expect(await countNotes()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))

    await waitFor(async () => expect(await countNotes()).toBe(1))
    const [note] = await listNotes()
    expect(note).toMatchObject({ bodyMd: '', deletedAt: null, dirty: true })
    // The new note lands in the list, counted, titled and selected.
    await screen.findByText('1 note')
    const row = screen.getByRole('button', { name: /^Untitled/ })
    expect(row.getAttribute('aria-current')).toBe('true')
    // Selecting it remembers it, which is what a reload reads back.
    await waitFor(async () =>
      expect((await db.meta.get('lastNoteId'))?.value).toBe(note!.id),
    )
  })

  it('finds a diacritic title from an unaccented query typed into the box', async () => {
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# množiny' })
    await createNote({ title: 'Lineárna algebra', bodyMd: 'vektory' })
    render(<App />)
    await screen.findByText('2 notes')

    const box = screen.getByRole('searchbox', { name: 'Search notes' })
    fireEvent.change(box, { target: { value: 'diskretna' } })

    await screen.findByText('1 match')
    screen.getByRole('button', { name: /^Diskrétna matematika/ })
    expect(screen.queryByRole('button', { name: /^Lineárna/ })).toBeNull()

    fireEvent.change(box, { target: { value: 'diskretna fyzika' } })

    await screen.findByText('No notes match your search.')
    await screen.findByText('0 matches')

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))

    await screen.findByText('2 notes')
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

    const row = await screen.findByRole('button', { name: /^Lineárna algebra/ })
    await waitFor(() => expect(row.getAttribute('aria-current')).toBe('true'))
    // The editor is open on it, not merely the row highlighted.
    screen.getByText('vektory')
    expect(
      screen.getByRole('button', { name: /^Diskrétna/ }).getAttribute('aria-current'),
    ).toBe('false')
  })

  it('falls back to the empty state when the remembered note was deleted', async () => {
    const note = await createNote({ title: 'Zmazaná', bodyMd: 'text' })
    await deleteNote(note.id)
    await db.meta.put({ key: 'lastNoteId', value: note.id })

    render(<App />)

    await screen.findByText('No notes yet. Create one to start writing.')
  })

  it('falls back to the empty state when the remembered id is not in the database', async () => {
    await createNote({ title: 'Diskrétna matematika', bodyMd: '# Množiny' })
    await db.meta.put({ key: 'lastNoteId', value: 'no-such-note' })

    render(<App />)

    await screen.findByText('Select a note, or create one.')
    expect(
      screen.getByRole('button', { name: /^Diskrétna/ }).getAttribute('aria-current'),
    ).toBe('false')
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
