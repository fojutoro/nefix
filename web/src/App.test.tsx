import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { countNotes, createNote, listNotes } from './db/notes.ts'
import { db } from './db/schema.ts'
import i18n from './i18n/index.ts'

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
    // App drains the push queue on mount. Refusing the request keeps these
    // tests off the network and leaves every note dirty, which is what the
    // assertions below already expect.
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
