import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { countNotes, listNotes } from './db/notes.ts'
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
  })

  afterEach(cleanup)

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
})
