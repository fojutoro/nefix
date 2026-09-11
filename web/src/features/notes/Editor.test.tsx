import 'fake-indexeddb/auto'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { Editor as TipTap } from '@tiptap/core'
import { Editor as BareEditor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Note } from '../../db/schema.ts'
import { updateNote } from '../../db/notes.ts'
import Editor, { editorExtensions, type OpenMath } from './Editor.tsx'
import { outline } from './outline.ts'
import { useAutosave } from './useAutosave.ts'

const ID = '0199a0f0-0000-7000-8000-000000000001'

// Focusing scrolls the caret into view, which measures it, and jsdom has no
// layout to measure. Nothing here tests scrolling.
const SILENT = { scrollIntoView: false }

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

// In a transaction, and the whole row at once, because that is how applyPage
// writes one: a subscription that only wakes for a bare put would pass here
// and never fire for an actual pull.
const write = (note: Note) =>
  db.transaction('rw', db.notes, () => db.notes.put(note))

const remoteChange = (bodyMd: string) => write(row(bodyMd, false))

// waitFor cannot prove that nothing happened, so the assertions that expect no
// change give the subscription a turn to deliver first.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)))

// TipTap hangs itself off the editable node, which is how a test reaches the
// document without the component having to hand it out.
const instanceIn = (container: HTMLElement): TipTap => {
  const dom = container.querySelector('.tiptap')
  const editor = (dom as (HTMLElement & { editor?: TipTap }) | null)?.editor
  if (!editor) throw new Error('the editor did not mount')
  return editor
}

// Typing, as ProseMirror sees it: the path input rules are attached to, so a
// test that types `$x^2$` exercises the same rule a person does.
const type = (editor: TipTap, text: string) => {
  const { view } = editor
  const { from, to } = view.state.selection
  const insert = () => view.state.tr.insertText(text, from, to)
  const handled = view.someProp('handleTextInput', (f) =>
    f(view, from, to, text, insert),
  )
  if (!handled) view.dispatch(insert())
}

async function open(bodyMd: string, dirty: boolean) {
  await write(row(bodyMd, dirty))
  const onChange = vi.fn()
  const { container } = render(
    <Editor
      noteId={ID}
      initialBody={bodyMd}
      label="Note body, Markdown"
      mathLabel="Formula, LaTeX"
      focus={false}
      onChange={onChange}
    />,
  )
  // The subscription delivers the row once on subscribe. Left unsettled, that
  // first emission can land after a test has typed and, finding a clean row
  // that no longer matches the document, replace what was typed.
  await settle()
  return { editor: instanceIn(container), container, onChange }
}

// The editor wired to the real autosave, the way App.tsx wires it.
function Harness({ bodyMd }: { bodyMd: string }) {
  const onChange = useAutosave(ID, 'Untitled', (id, patch) => updateNote(id, patch))
  return (
    <Editor
      noteId={ID}
      initialBody={bodyMd}
      label="Note body, Markdown"
      mathLabel="Formula, LaTeX"
      focus={false}
      onChange={onChange}
    />
  )
}

describe('Editor', () => {
  beforeEach(async () => {
    await db.notes.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('takes a remote body into the document when the note is not dirty', async () => {
    const { editor } = await open('what this window had', false)

    await remoteChange('what the other window wrote')

    await waitFor(() =>
      expect(editor.getMarkdown()).toBe('what the other window wrote'),
    )
  })

  it('leaves the document alone when the note is dirty', async () => {
    const { editor } = await open('what the user is typing', true)

    // The one write that must never reach the editor: the row holds local
    // edits, and the next push either lands them or forks them.
    await write(row('what the other window wrote', true))
    await settle()

    expect(editor.getMarkdown()).toBe('what the user is typing')

    // And the subscription really was listening, so the assertion above is the
    // guard holding rather than nothing being delivered at all.
    await remoteChange('and now the note is clean')
    await waitFor(() =>
      expect(editor.getMarkdown()).toBe('and now the note is clean'),
    )
  })

  // The echo-back bug. A naive update handler passes every other test in this
  // file: the document does get the remote body, and the editor looks right.
  // What it also does is report that body back as something the user typed,
  // which saves it as a local edit and forks the note against the server's own
  // text on the next push. The assertion is on the row, not the callback,
  // because the row is what sync reads.
  it('does not mark the note dirty when the body arrived from sync', async () => {
    await write(row('what this window had', false))
    // The real autosave, so a leaked update actually writes and actually
    // marks the row. With a spy here the assertion could not fail: a spy
    // never writes, so the row would read clean however loudly the update
    // handler fired.
    render(<Harness bodyMd="what this window had" />)
    await settle()

    await remoteChange('what the other window wrote')
    // Past the autosave debounce, so a leaked update has had its chance.
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)))

    const after = await db.notes.get(ID)
    expect(after?.dirty).toBe(false)
    expect(after?.bodyMd).toBe('what the other window wrote')
  })

  // #37. `dirty` means "IndexedDB differs from the server", which is not the
  // same question as "the editor has changes IndexedDB has not seen". Between
  // a keystroke and autosave firing 500ms later, on a note that was just
  // pushed and is therefore clean, a pull used to replace the document and
  // take the keystrokes with it.
  it('keeps characters typed since the last save when a remote update lands', async () => {
    await write(row('abc', false))
    const { container } = render(<Harness bodyMd="abc" />)
    const editor = instanceIn(container)
    await settle()

    // Type, and let autosave carry it all the way to the row.
    await act(async () => {
      editor.commands.focus('end', SILENT)
      type(editor, 'd')
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)))
    expect((await db.notes.get(ID))?.bodyMd).toBe('abcd')

    // A push lands and clears the flag. The row and the document agree, and
    // nothing about the note is dirty any more.
    await write(row('abcd', false))
    await settle()

    // One more keystroke. This is the window: autosave is armed but has not
    // fired, so the row still says `abcd` and still says clean.
    await act(async () => {
      editor.commands.focus('end', SILENT)
      type(editor, 'e')
    })
    expect(editor.getMarkdown()).toBe('abcde')

    // A pull arrives inside that window.
    await remoteChange('what the other window wrote')
    await settle()

    // The keystroke is still on screen.
    expect(editor.getMarkdown()).toBe('abcde')

    // And it wins: the pending write lands, and the row holds what was typed
    // rather than what the pull brought.
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)))
    const after = await db.notes.get(ID)
    expect(after?.bodyMd).toBe('abcde')
    expect(after?.dirty).toBe(true)
  })

  // useAutosave clears its pending write at the top of flush, before the save
  // it then starts has reached IndexedDB. A guard reading that timer would be
  // open for the length of the write; this one stays shut until a row comes
  // back carrying the text, so a pull landing mid-write is refused too.
  it('keeps typing safe while the save is still in flight', async () => {
    await write(row('abc', false))
    let release = () => {}
    const slowSave = async (id: string, patch: { bodyMd: string; title: string }) => {
      await new Promise<void>((resolve) => { release = resolve })
      await updateNote(id, patch)
    }
    function Slow() {
      const onChange = useAutosave(ID, 'Untitled', slowSave)
      return (
        <Editor
          noteId={ID}
          initialBody="abc"
          label="Note body, Markdown"
          mathLabel="Formula, LaTeX"
          focus={false}
          onChange={onChange}
        />
      )
    }
    const { container } = render(<Slow />)
    const editor = instanceIn(container)
    await settle()

    await act(async () => {
      editor.commands.focus('end', SILENT)
      type(editor, 'd')
    })
    // Past the debounce, so flush has run and dropped its pending write, but
    // the save itself is still suspended and the row still says `abc`.
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)))
    expect((await db.notes.get(ID))?.bodyMd).toBe('abc')

    await remoteChange('what the other window wrote')
    await settle()

    expect(editor.getMarkdown()).toBe('abcd')

    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect((await db.notes.get(ID))?.bodyMd).toBe('abcd')
  })

  // The other half: refusing while a write is pending must not become
  // refusing altogether. Once autosave has caught up, the note is quiet again
  // and a pull is free to land.
  it('still takes a remote body once typing has been saved', async () => {
    await write(row('abc', false))
    const { container } = render(<Harness bodyMd="abc" />)
    const editor = instanceIn(container)
    await settle()

    await act(async () => {
      editor.commands.focus('end', SILENT)
      type(editor, 'd')
    })
    // All the way through autosave, and then a push clearing the flag, so
    // there is nothing outstanding anywhere.
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)))
    await write(row('abcd', false))
    await settle()

    await remoteChange('what the other window wrote')

    await waitFor(() =>
      expect(editor.getMarkdown()).toBe('what the other window wrote'),
    )
  })

  it('marks the note dirty and autosaves what the editor serialised', async () => {
    await write(row('# Heading\n\nbody', false))
    const { container } = render(<Harness bodyMd={'# Heading\n\nbody'} />)
    const editor = instanceIn(container)
    await settle()

    await act(async () => {
      editor.commands.focus('end', SILENT)
      type(editor, ' more')
    })
    // Past the 500ms debounce, then the write itself.
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)))

    const after = await db.notes.get(ID)
    expect(after?.dirty).toBe(true)
    expect(after?.bodyMd).toBe('# Heading\n\nbody more')
    // Markdown, not HTML or JSON: body_md is a string and stays one.
    expect(after?.bodyMd).not.toContain('<')
  })

  it('is contenteditable, so the n shortcut does not fire inside it', async () => {
    const { container, editor } = await open('a note', false)
    const dom = container.querySelector('.tiptap') as HTMLElement

    // The exact predicate App.tsx guards the shortcut with. jsdom leaves
    // isContentEditable false, so `closest` is the branch doing the work
    // there too.
    expect(dom.getAttribute('contenteditable')).toBe('true')
    expect(
      dom.closest('input, textarea, select, [contenteditable]'),
    ).not.toBeNull()

    // And the letter itself lands in the note rather than being swallowed.
    await act(async () => {
      editor.commands.focus('end', SILENT)
      type(editor, 'n')
    })
    expect(editor.getMarkdown()).toBe('a noten')
  })

  it('writes headings that outline can still find', async () => {
    const { editor } = await open(
      '# Diskrétna matematika\n\n## Definície\n\ntext\n\n## Dôkazy\n\nmore',
      false,
    )
    // outline skips the first line, which is already the title on the row.
    expect(outline(editor.getMarkdown())).toEqual(['Definície', 'Dôkazy'])
  })
})

// Built bare rather than through the component: these are about the extension
// wiring, and a click handler is easier to believe when nothing else is
// between the formula and the assertion.
describe('maths', () => {
  const build = (content: string, onOpen?: OpenMath) => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = new BareEditor({
      element,
      extensions: editorExtensions(onOpen),
      content,
      contentType: 'markdown',
    })
    return { editor, element }
  }

  it('hands a click the formula source and its position', () => {
    const onOpen = vi.fn<OpenMath>()
    const { editor, element } = build('Inline $\\frac{1}{2}$ here.', onOpen)

    const formula = element.querySelector('[data-type="inline-math"]')!
    formula.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onOpen).toHaveBeenCalledTimes(1)
    const [pos, latex, block] = onOpen.mock.calls[0]!
    expect(latex).toBe('\\frac{1}{2}')
    expect(block).toBe(false)
    expect(typeof pos).toBe('number')
    editor.destroy()
  })

  it('changes one character without deleting the node or the text round it', () => {
    const onOpen = vi.fn<OpenMath>()
    const { editor, element } = build('Inline $\\frac{1}{2}$ here.', onOpen)
    element
      .querySelector('[data-type="inline-math"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const [pos, latex] = onOpen.mock.calls[0]!

    editor
      .chain()
      .updateInlineMath({ latex: (latex as string).replace('1', '3'), pos })
      .run()

    expect(editor.getMarkdown()).toBe('Inline $\\frac{3}{2}$ here.')
    // Still one node, re-rendered rather than replaced with plain text.
    expect(
      element.querySelector('[data-type="inline-math"]')?.getAttribute('data-latex'),
    ).toBe('\\frac{3}{2}')
    editor.destroy()
  })

  it('does not throw or lose the editor on a formula KaTeX cannot parse', () => {
    const { editor, element } = build('Broken $\\frac{$ and more text.')

    expect(element.querySelector('.inline-math-error')).not.toBeNull()
    // The rest of the note is still there and still editable.
    expect(editor.getMarkdown()).toContain('and more text.')
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('true')
    editor.destroy()
  })

  it('creates a block formula from `$$ ` and opens it to be filled', async () => {
    const onOpen = vi.fn<OpenMath>()
    const { editor, element } = build('', onOpen)

    editor.commands.focus(null, SILENT)
    type(editor, '$')
    type(editor, '$')
    type(editor, ' ')

    expect(editor.state.doc.firstChild?.type.name).toBe('blockMath')
    // Empty, and therefore useless until something puts a formula in it, so
    // the source field is opened over it rather than leaving a blank box.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onOpen).toHaveBeenCalledTimes(1)
    const [pos, latex, block] = onOpen.mock.calls[0]!
    expect(block).toBe(true)
    expect(latex).toBe('')

    editor.chain().updateBlockMath({ latex: 'a^2+b^2=c^2', pos }).run()
    expect(editor.getMarkdown().replace(/\n*$/, '')).toBe('$$\na^2+b^2=c^2\n$$')
    expect(
      element.querySelector('[data-type="block-math"]')?.getAttribute('data-latex'),
    ).toBe('a^2+b^2=c^2')
    editor.destroy()
  })

  it('turns `$x^2$` into a formula as it is typed, and leaves money alone', () => {
    const { editor } = build('', vi.fn())
    editor.commands.focus(null, SILENT)
    for (const char of 'Inline $x^2$ here.') type(editor, char)
    expect(editor.getMarkdown()).toBe('Inline $x^2$ here.')
    expect(editor.state.doc.textContent).not.toContain('$')

    const money = build('', vi.fn())
    money.editor.commands.focus(null, SILENT)
    for (const char of 'It costs $5 and $10 today.') type(money.editor, char)
    expect(money.editor.getMarkdown()).toBe('It costs $5 and $10 today.')
    money.editor.destroy()
    editor.destroy()
  })
})
