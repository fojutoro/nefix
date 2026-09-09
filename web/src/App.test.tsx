import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { countNotes, createNote, listNotes } from './db/notes.ts'
import { db } from './db/schema.ts'
import i18n from './i18n/index.ts'
import { sync } from './sync/index.ts'

// The triggers are what the second block of tests is about, so sync itself is
// a spy: when it is called is the whole question, not what it does. hoisted,
// because vi.mock's factory runs before the module body.
const { idle } = vi.hoisted(() => ({
  idle: () =>
    Promise.resolve({
      push: { pushed: 0, conflicted: 0, forbidden: 0, failed: 0 },
      pull: { applied: 0, skipped: 0, pages: 0 },
      changed: false,
    }),
}))

vi.mock('./sync/index.ts', () => ({ sync: vi.fn(idle) }))

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
    await i18n.changeLanguage('en')
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
    await i18n.changeLanguage('en')
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
