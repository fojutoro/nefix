import 'fake-indexeddb/auto'
import { act, cleanup, render } from '@testing-library/react'
import type { Editor as TipTap } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateNote } from '../../db/notes.ts'
import { db, type Note } from '../../db/schema.ts'
import Collegebook from './Collegebook.tsx'

// jsdom has no layout engine, so ProseMirror's coordsAtPos has nothing to
// measure. See the same block in Editor.test.tsx.
const EMPTY_RECT = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
} as DOMRect
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => EMPTY_RECT

const SILENT = { scrollIntoView: false }

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)))
const past = (ms = 700) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

const pageId = (n: number) => `0199a0f0-0000-7000-8000-${String(n).padStart(12, '0')}`

const BOOK = '0199a0c1-0000-7000-8000-000000000001'

const page = (n: number, bodyMd: string): Note => ({
  id: pageId(n),
  classId: null,
  notebookId: BOOK,
  pageOrder: n,
  title: `Page ${n}`,
  bodyMd,
  searchText: '',
  visibility: 'private',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  deletedAt: null,
  forkedFromId: null,
  version: 1,
  dirty: false,
  syncedAt: '2026-09-01T10:00:00.000Z',
})

// jsdom implements no IntersectionObserver at all, so the component's one
// mounting rule would otherwise be untestable — and untested, "near the
// viewport" would mean whatever the last edit left it meaning. This fake
// hands the test the callback and lets it deliver entries by hand.
type Delivery = { id: string; isIntersecting: boolean; height?: number }

let deliver: (entries: Delivery[]) => void

class FakeObserver {
  private targets = new Map<string, Element>()

  constructor(callback: IntersectionObserverCallback) {
    deliver = (entries) => {
      const payload = entries.map((entry) => {
        const target = this.targets.get(entry.id)
        if (target === undefined) throw new Error(`${entry.id} is not observed`)
        return {
          target,
          isIntersecting: entry.isIntersecting,
          boundingClientRect: { height: entry.height ?? 100 } as DOMRect,
        } as IntersectionObserverEntry
      })
      act(() => callback(payload, this as unknown as IntersectionObserver))
    }
  }

  observe(element: Element) {
    this.targets.set((element as HTMLElement).dataset.page ?? '', element)
  }

  unobserve() {}

  disconnect() {
    this.targets.clear()
  }
}

vi.stubGlobal('IntersectionObserver', FakeObserver)

const instances = (container: HTMLElement): TipTap[] =>
  [...container.querySelectorAll('.tiptap')].map((dom) => {
    const editor = (dom as HTMLElement & { editor?: TipTap }).editor
    if (!editor) throw new Error('the editor did not mount')
    return editor
  })

const type = (editor: TipTap, text: string) => {
  const { view } = editor
  const { from, to } = view.state.selection
  const insert = () => view.state.tr.insertText(text, from, to)
  const handled = view.someProp('handleTextInput', (f) =>
    f(view, from, to, text, insert),
  )
  if (!handled) view.dispatch(insert())
}

// The reading view wired to the real writer, the way App.tsx wires it: a spy
// never writes, so a test using one could not tell a page being overwritten
// from a page being left alone.
const show = async (pages: Note[]) => {
  await db.notes.bulkPut(pages)
  const view = render(
    <Collegebook
      pages={pages}
      label="Note body, Markdown"
      mathLabel="Formula, LaTeX"
      untitled="Untitled"
      save={(id, patch) => updateNote(id, patch)}
      onCreatePage={() => {}}
    />,
  )
  await settle()
  return view
}

beforeEach(async () => {
  await db.notes.clear()
})

afterEach(cleanup)

describe('a collegebook', () => {
  it('builds an editor for the pages near the viewport and holds the rest', async () => {
    const { container } = await show([
      page(1, 'first'),
      page(2, 'second'),
      page(3, 'third'),
      page(4, 'fourth'),
    ])

    // Before the observer has reported: the opening window, so a book opens
    // on its first page rather than on a placeholder.
    expect(instances(container)).toHaveLength(2)

    // A real observer describes every page it watches as soon as it is built.
    await act(async () =>
      deliver([
        { id: pageId(1), isIntersecting: true },
        { id: pageId(2), isIntersecting: true },
        { id: pageId(3), isIntersecting: false },
        { id: pageId(4), isIntersecting: false },
      ]),
    )

    // Twenty TipTap instances at once is the thing this exists to prevent, so
    // the count is the assertion.
    expect(instances(container)).toHaveLength(2)
    const held = [...container.querySelectorAll('.page-holder')]
    expect(held).toHaveLength(2)
    // The text is in the placeholder, so scrolling past reads as pages going
    // by rather than as empty boxes.
    expect(held[0]?.textContent).toBe('third')

    // Scrolled to: the observer reports it, and only then is it built.
    await act(async () => deliver([{ id: pageId(4), isIntersecting: true }]))
    expect(instances(container)).toHaveLength(3)
  })

  it('remembers a page at the height it was last seen', async () => {
    const { container } = await show([page(1, 'first'), page(2, 'second')])

    // Page 1 has overflowed its nominal height, and then the reader scrolls
    // past it.
    await act(async () =>
      deliver([{ id: pageId(1), isIntersecting: false, height: 1234 }]),
    )

    const first = container.querySelector<HTMLElement>(`[data-page="${pageId(1)}"]`)
    // Without this the placeholder would fall back to the nominal height, the
    // page would shrink as it was torn down, and the scroll position would
    // jump under the reader.
    expect(first?.style.getPropertyValue('--measured')).toBe('1234px')
    expect(first?.querySelector('.page-holder')).not.toBeNull()
  })

  it('keeps typing on one page out of the page above it', async () => {
    const { container } = await show([page(1, 'first'), page(2, 'second')])
    const [first, second] = instances(container)

    await act(async () => {
      second!.commands.focus('end', SILENT)
      type(second!, ' edited')
    })
    await past()

    expect(first!.getMarkdown()).toBe('first')
    expect((await db.notes.get(pageId(2)))?.bodyMd).toBe('second edited')
    // The row above is untouched, which is what one autosave per page buys:
    // a shared one would carry the pending write to whichever page was last
    // typed in.
    expect(await db.notes.get(pageId(1))).toMatchObject({
      bodyMd: 'first',
      dirty: false,
    })
  })

  it('does not let a pull overwrite the page being typed into', async () => {
    const { container } = await show([page(1, 'first'), page(2, 'second')])
    const [first, second] = instances(container)

    // Typed, and not yet saved: this is the window the echo-back guard covers,
    // and it has to hold for each page on its own.
    await act(async () => {
      second!.commands.focus('end', SILENT)
      type(second!, '!')
    })
    expect(second!.getMarkdown()).toBe('second!')

    // A pull lands on both pages at once, which is what a page of remote
    // changes actually looks like.
    await act(async () => {
      await db.transaction('rw', db.notes, async () => {
        await db.notes.put({ ...page(1, 'first from the other device') })
        await db.notes.put({ ...page(2, 'second from the other device') })
      })
    })
    await settle()

    // The page being typed into keeps what was typed.
    expect(second!.getMarkdown()).toBe('second!')
    // The page that was not typed into takes the remote text, because that is
    // what the guard is for: it protects unsaved keystrokes, not every page
    // in the book.
    expect(first!.getMarkdown()).toBe('first from the other device')

    await past()
    expect((await db.notes.get(pageId(2)))?.bodyMd).toBe('second!')
  })
})
