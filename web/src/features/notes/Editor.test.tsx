import 'fake-indexeddb/auto'
import { cleanup, render, waitFor } from '@testing-library/react'
import { EditorView } from 'codemirror'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Note } from '../../db/schema.ts'
import Editor from './Editor.tsx'

// CodeMirror measures itself once it mounts, and jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver ??= NoopResizeObserver

const ID = '0199a0f0-0000-7000-8000-000000000001'

const row = (bodyMd: string, dirty: boolean): Note => ({
  id: ID,
  classId: null,
  notebookId: null,
  title: 'Diskrétna matematika',
  bodyMd,
  searchText: '',
  visibility: 'private',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  deletedAt: null,
  forkedFromId: null,
  version: 1,
  dirty,
  syncedAt: '2026-09-01T10:00:00.000Z',
})

// In a transaction, and the whole row at once, because that is how
// applyPage writes one: a subscription that only wakes for a bare put would
// pass here and never fire for an actual pull.
const write = (note: Note) =>
  db.transaction('rw', db.notes, () => db.notes.put(note))

const remoteChange = (bodyMd: string) => write(row(bodyMd, false))

// waitFor cannot prove that nothing happened, so the assertions that expect
// no change give the subscription a turn to deliver first.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

async function open(bodyMd: string, dirty: boolean) {
  await write(row(bodyMd, dirty))
  const onChange = vi.fn()
  const { container } = render(
    <Editor
      noteId={ID}
      initialBody={bodyMd}
      label="Note body, Markdown"
      onChange={onChange}
    />,
  )
  const view = EditorView.findFromDOM(container.querySelector('.editor')!)
  if (view === null) throw new Error('the editor view did not mount')
  expect(view.state.doc.toString()).toBe(bodyMd)
  return { view, onChange }
}

describe('Editor', () => {
  beforeEach(async () => {
    await db.notes.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('takes a remote body into the document when the note is not dirty', async () => {
    const { view, onChange } = await open('what this window had', false)

    await remoteChange('what the other window wrote')

    await waitFor(() =>
      expect(view.state.doc.toString()).toBe('what the other window wrote'),
    )
    // The transaction is annotated as remote, so the update listener does not
    // report it back as something the user typed. Reported, it would be saved
    // as a local edit and pushed, forking the note against the server's own
    // text on the next cycle.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves the document alone when the note is dirty', async () => {
    const { view, onChange } = await open('what the user is typing', true)

    // The one write that must never reach the editor: the row holds local
    // edits, and the next push either lands them or forks them.
    await write(row('what the other window wrote', true))
    await settle()

    expect(view.state.doc.toString()).toBe('what the user is typing')
    expect(onChange).not.toHaveBeenCalled()

    // And the subscription really was listening, so the assertions above are
    // the guard holding rather than nothing being delivered at all.
    await remoteChange('and now the note is clean')
    await waitFor(() =>
      expect(view.state.doc.toString()).toBe('and now the note is clean'),
    )
  })

  it('keeps the cursor where it was, clamped to a shorter body', async () => {
    const { view } = await open('a body long enough to sit inside', false)
    view.dispatch({ selection: { anchor: 20 } })

    await remoteChange('another body long enough to sit inside')
    await waitFor(() =>
      expect(view.state.doc.toString()).toBe(
        'another body long enough to sit inside',
      ),
    )
    expect(view.state.selection.main.head).toBe(20)

    await remoteChange('short')
    await waitFor(() => expect(view.state.doc.toString()).toBe('short'))
    // Clamped to the new length rather than left pointing past the end.
    expect(view.state.selection.main.head).toBe(5)
  })
})
