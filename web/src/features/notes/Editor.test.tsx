import 'fake-indexeddb/auto'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Editor as TipTap } from '@tiptap/core'
import type { Node as ProseMirrorNodeLike } from '@tiptap/pm/model'
import { Editor as BareEditor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n/index.ts'
import { db, type Note } from '../../db/schema.ts'
import { createDeadline } from '../../db/deadlines.ts'
import { updateNote } from '../../db/notes.ts'
import CSS from '../../index.css?raw'
import Editor, { editorExtensions, type OpenMath } from './Editor.tsx'
import { TURN_INTO } from './blocks.ts'
import { outline } from './outline.ts'
import { markTopics } from './topics.ts'
import { useAutosave } from './useAutosave.ts'

const ID = '0199a0f0-0000-7000-8000-000000000001'

// jsdom has no layout engine, so a Range has neither getClientRects nor
// getBoundingClientRect, and ProseMirror's coordsAtPos asks for both before it
// can say where a position sits. Zeros satisfy it. Nothing below asserts where
// the menu landed — that is the part only an eye can check.
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

// Focusing scrolls the caret into view, which measures it, and jsdom has no
// layout to measure. Nothing here tests scrolling.
const SILENT = { scrollIntoView: false }

const row = (bodyMd: string, dirty: boolean): Note => ({
  id: ID,
  classId: null,
  notebookId: null,
  pageOrder: null,
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

describe('highlight', () => {
  const build = (content: string) => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    return new BareEditor({
      element,
      extensions: editorExtensions(),
      content,
      contentType: 'markdown',
    })
  }

  // The text carrying the mark, run by run, so a highlight is told apart from
  // equals signs that only look like one.
  const highlighted = (editor: TipTap) => {
    const runs: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'highlight')) {
        runs.push(node.text!)
      }
    })
    return runs
  }

  // The same note opened again from what was saved.
  const reopened = (editor: TipTap) => {
    const again = build(editor.getMarkdown())
    const runs = highlighted(again)
    again.destroy()
    return runs
  }

  const typed = (text: string) => {
    const editor = build('')
    editor.commands.focus(null, SILENT)
    for (const char of text) type(editor, char)
    return editor
  }

  it('turns ==text== into a highlight as the closing == is typed, and it reopens as one', () => {
    const editor = typed('A ==marked== word.')

    expect(editor.state.doc.textContent).toBe('A marked word.')
    expect(highlighted(editor)).toEqual(['marked'])
    expect(editor.getMarkdown()).toBe('A ==marked== word.')
    expect(reopened(editor)).toEqual(['marked'])
    editor.destroy()
  })

  // The rule matches only what the reader accepts. Bold's pattern allows spaces
  // inside the delimiters, and `== a ==` typed under it would save as a
  // highlight that reopens as literal text.
  it('leaves == in prose and around spaces literal, and saves it escaped', () => {
    const prose = typed('if x == y == z')
    expect(highlighted(prose)).toEqual([])
    expect(prose.getMarkdown()).toBe('if x \\== y \\== z')
    expect(reopened(prose)).toEqual([])
    prose.destroy()

    const spaced = typed('== a ==')
    expect(highlighted(spaced)).toEqual([])
    expect(spaced.getMarkdown()).toBe('\\== a \\==')
    expect(reopened(spaced)).toEqual([])
    spaced.destroy()
  })

  it('undoes the rule straight after it fires, keeping == as typed and saving it escaped', () => {
    const editor = typed('==kept==')
    expect(highlighted(editor)).toEqual(['kept'])

    editor.commands.undoInputRule()

    expect(editor.state.doc.textContent).toBe('==kept==')
    expect(highlighted(editor)).toEqual([])
    expect(editor.getMarkdown()).toBe('\\==kept\\==')
    expect(reopened(editor)).toEqual([])
    editor.destroy()
  })

  it('turns pasted ==text== into a highlight, and leaves pasted prose literal', () => {
    const editor = build('')
    editor.commands.focus(null, SILENT)

    // jsdom has no ClipboardEvent, which pasteText builds when it is given no
    // event. The paste path is the same with a plain one.
    editor.view.pasteText('A ==pasted== word and x == y', new Event('paste') as ClipboardEvent)

    expect(highlighted(editor)).toEqual(['pasted'])
    expect(editor.getMarkdown()).toBe('A ==pasted== word and x \\== y')
    expect(reopened(editor)).toEqual(['pasted'])
    editor.destroy()
  })

  // Applied as selected, this would save as `one== two ==three` and reopen as
  // literal text. The mark trims first, so every path that applies it does.
  it('trims the spaces around a selection before highlighting, so it reopens as a highlight', () => {
    const editor = build('one two three')
    // " two ": from the space after "one" to the space before "three".
    editor.commands.setTextSelection({ from: 4, to: 9 })

    editor.commands.setHighlight()

    expect(highlighted(editor)).toEqual(['two'])
    expect(editor.getMarkdown()).toBe('one ==two== three')
    expect(reopened(editor)).toEqual(['two'])
    editor.destroy()
  })

  it('toggles a highlight on the selection with Mod-Shift-H', () => {
    const editor = build('one two three')
    editor.commands.setTextSelection({ from: 4, to: 9 })
    // Mod is Ctrl here because jsdom reports no Mac platform; on a Mac the
    // same binding is Cmd.
    const press = () =>
      editor.view.someProp('handleKeyDown', (f) =>
        f(
          editor.view,
          new KeyboardEvent('keydown', { key: 'H', keyCode: 72, ctrlKey: true, shiftKey: true }),
        ),
      )

    press()
    expect(highlighted(editor)).toEqual(['two'])
    expect(editor.getMarkdown()).toBe('one ==two== three')

    // The same selection again, spaces and all, takes it off.
    press()
    expect(highlighted(editor)).toEqual([])
    expect(editor.getMarkdown()).toBe('one two three')
    editor.destroy()
  })
})

// The menu is driven entirely by the editor's own selection, so every test
// below moves the selection through commands rather than through events. That
// is the point of the "opens from a selection change" test: a `mouseup`
// listener would satisfy a mouse-driven test and leave a finger with no way
// to format anything.
describe('bubble menu', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
  })

  const select = async (editor: TipTap, from: number, to: number) => {
    await act(async () => {
      editor.commands.setTextSelection({ from, to })
    })
  }

  const menuIn = (container: HTMLElement) => container.querySelector('.bubble-menu')

  const press = async (element: HTMLElement, key: string) => {
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      )
    })
  }

  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click()
    })
  }

  it('opens on a non-empty selection and stays shut on a collapsed one', async () => {
    const { editor, container } = await open('bold me please', false)
    expect(menuIn(container)).toBeNull()

    await select(editor, 1, 5)
    expect(menuIn(container)).not.toBeNull()

    await select(editor, 3, 3)
    expect(menuIn(container)).toBeNull()
  })

  // The mutation that matters. A `mouseup` implementation passes a test that
  // clicks, and fails both halves of this one: nothing here dispatches a mouse
  // event to open the menu, and the mouse event that is dispatched must not
  // open it on its own.
  it('opens from a selection change rather than from a mouse event', async () => {
    const { editor, container } = await open('bold me please', false)
    const dom = container.querySelector('.tiptap') as HTMLElement

    await act(async () => {
      dom.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    expect(menuIn(container)).toBeNull()

    await select(editor, 1, 5)
    expect(menuIn(container)).not.toBeNull()
  })

  it('closes on Escape and leaves the selection where it was', async () => {
    const { editor, container } = await open('bold me please', false)
    await select(editor, 1, 5)
    expect(menuIn(container)).not.toBeNull()

    await press(container.querySelector('.tiptap') as HTMLElement, 'Escape')

    expect(menuIn(container)).toBeNull()
    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.to).toBe(5)
  })

  it('applies bold to the selection and shows the button as active', async () => {
    const { editor, container } = await open('bold me please', false)
    await select(editor, 1, 5)

    expect(screen.getByLabelText('Bold').getAttribute('aria-pressed')).toBe('false')
    await click(screen.getByLabelText('Bold'))

    expect(editor.getMarkdown()).toBe('**bold** me please')
    expect(screen.getByLabelText('Bold').getAttribute('aria-pressed')).toBe('true')
    expect(menuIn(container)).not.toBeNull()
  })

  it('toggles a heading level, and toggles it back to paragraph', async () => {
    const { editor } = await open('a line', false)
    await select(editor, 1, 3)

    await click(screen.getByLabelText('Heading 2'))
    // The serialiser ends a heading with a blank line, the way the existing
    // block-maths test already allows for.
    expect(editor.getMarkdown().replace(/\n*$/, '')).toBe('## a line')
    expect(screen.getByLabelText('Heading 2').getAttribute('aria-pressed')).toBe('true')

    await click(screen.getByLabelText('Heading 2'))
    expect(editor.getMarkdown().replace(/\n*$/, '')).toBe('a line')
  })

  it('prefills the link input, commits a new href, and removes on empty', async () => {
    const { editor } = await open('see [the docs](https://old.example) here', false)
    await select(editor, 5, 13)

    await click(screen.getByLabelText('Link'))
    const input = screen.getByLabelText('Link URL') as HTMLInputElement
    expect(input.value).toBe('https://old.example')

    input.value = 'https://new.example'
    await press(input, 'Enter')
    expect(editor.getMarkdown()).toBe('see [the docs](https://new.example) here')

    await select(editor, 5, 13)
    await click(screen.getByLabelText('Link'))
    const again = screen.getByLabelText('Link URL') as HTMLInputElement
    again.value = ''
    await press(again, 'Enter')
    expect(editor.getMarkdown()).toBe('see the docs here')
  })

  it('wraps the selection in a formula whose latex is the selected text', async () => {
    const { editor, container } = await open('area a^2+b^2 here', false)
    await select(editor, 6, 13)

    await click(screen.getByLabelText('Formula'))

    expect(editor.getMarkdown()).toBe('area $a^2+b^2$ here')
    expect(
      container.querySelector('[data-type="inline-math"]')?.getAttribute('data-latex'),
    ).toBe('a^2+b^2')
    // And the source field is over it, so the formula can be corrected
    // without retyping it.
    expect((screen.getByLabelText('Formula, LaTeX') as HTMLInputElement).value).toBe(
      'a^2+b^2',
    )
  })

  // Clicking a formula makes a NodeSelection, which is not empty. A menu that
  // only asks "is the selection empty?" opens on top of the formula source
  // field and takes the focus the field needs.
  it('stays shut on a node selection, so it cannot cover the formula field', async () => {
    const { editor, container } = await open('inline $x^2$ here', false)
    let mathPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'inlineMath') mathPos = pos
    })
    expect(mathPos).toBeGreaterThan(-1)

    await act(async () => {
      editor.commands.setNodeSelection(mathPos)
    })

    // Not empty, so the naive guard would have opened the menu here.
    expect(editor.state.selection.empty).toBe(false)
    expect(menuIn(container)).toBeNull()
  })

  // The interaction most likely to break: the menu must not sit over the
  // formula source field or hold the focus that field needs. With the editor
  // focused — the only way a person reaches this — the field taking focus
  // blurs the document, and the blur is what closes the menu.
  it('gives way to the formula source field', async () => {
    const { editor, container } = await open('pick me $x^2$ here', false)
    await act(async () => {
      editor.commands.focus(null, SILENT)
      editor.commands.setTextSelection({ from: 1, to: 5 })
    })
    // focus() lands in a requestAnimationFrame, so the DOM focus it is about
    // to take is not taken yet.
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(menuIn(container)).not.toBeNull()

    await act(async () => {
      container
        .querySelector('[data-type="inline-math"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('.math-source')).not.toBeNull()
    expect(menuIn(container)).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('.math-source'))
  })

  it('renders display maths in a centred block wrapper', async () => {
    const { container } = await open('$$\na^2+b^2=c^2\n$$', false)

    const wrapper = container.querySelector('[data-type="block-math"]')
    expect(wrapper?.tagName).toBe('DIV')
    // KaTeX only emits .katex-display in display mode, and display mode is
    // what centres it. Without it the formula renders inline, flush left.
    expect(wrapper?.querySelector('.katex-display')).not.toBeNull()
  })
})

// Structural only, and worth being exact about what that buys. The stylesheet
// is not loaded when a component renders under vitest — CSS imports are
// stubbed — so it is injected here from the same file the app ships. jsdom
// applies the cascade but returns *specified* values: it resolves neither
// var() nor rem, and it performs no layout at all. So these prove which token
// each level was given and that the tokens descend. They cannot prove a
// rendered pixel size, a line length, or that any of it is legible. Nothing
// here has seen a screen.
describe('editor typography', () => {
  // ?raw rather than node:fs: the app's tsconfig types only the browser, and
  // widening it to Node so a test can read a file is how `fs` ends up
  // imported into a PWA. Vite hands the file over as a string either way.
  const mounted: HTMLElement[] = []

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.remove()
  })

  const paint = (html: string) => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    const editor = document.createElement('div')
    editor.className = 'editor'
    editor.innerHTML = `<div class="tiptap">${html}</div>`
    document.body.appendChild(editor)
    mounted.push(style, editor)
    return editor.firstElementChild as HTMLElement
  }

  // The declared value of a :root token, read out of the same stylesheet, so
  // the scale is checked against what ships rather than against a number
  // copied into the test.
  const remOf = (token: string) => {
    const declared = new RegExp(`--${token}:\\s*([^;]+);`).exec(CSS)
    if (declared === null) throw new Error(`index.css declares no --${token}`)
    const size = /^([\d.]+)rem$/.exec(declared[1]!.trim())
    if (size === null) throw new Error(`--${token} is ${declared[1]}, not a rem`)
    return Number(size[1])
  }

  const tokenOf = (element: Element) => {
    const declared = getComputedStyle(element).fontSize.trim()
    const name = /^var\(--([\w-]+)\)$/.exec(declared)
    if (name === null) throw new Error(`font-size is "${declared}", not a token`)
    return name[1]!
  }

  it('gives h1, h2 and h3 three different sizes, descending, all above body', () => {
    const tiptap = paint('<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><p>e</p>')
    const levels = ['h1', 'h2', 'h3'].map((tag) => tokenOf(tiptap.querySelector(tag)!))

    // The old rule gave h1 and h2 both --title and h3 --body, so this is the
    // assertion that was failing: six levels, two sizes.
    expect(new Set(levels).size).toBe(3)

    const sizes = levels.map(remOf)
    expect(sizes[0]).toBeGreaterThan(sizes[1]!)
    expect(sizes[1]).toBeGreaterThan(sizes[2]!)
    // And the smallest of them is still larger than a paragraph. With the
    // markdown syntax invisible, a heading that measures the same as body
    // text is not a heading.
    expect(sizes[2]).toBeGreaterThan(remOf('body'))

    // h4 may share --body, but then it has to differ by weight.
    const h4 = tiptap.querySelector('h4')!
    expect(getComputedStyle(h4).fontWeight).not.toBe(
      getComputedStyle(tiptap.querySelector('p')!).fontWeight,
    )
  })

  it('gives a heading more space above it than below it', () => {
    // h3, not h2: h2 carries its own margin-top override, so it would report
    // that whatever the shared heading rule said.
    const tiptap = paint('<h3>c</h3>')
    const { marginTop, marginBottom } = getComputedStyle(tiptap.querySelector('h3')!)
    // calc() and var() come back unresolved, so the --gap multiplier inside is
    // what there is to compare; both margins are multiples of --gap by
    // construction. Declared as longhands in the stylesheet precisely so both
    // are readable here — jsdom does not expand a `margin` shorthand that
    // contains calc(), and a missing value silently comparing as 1 is how this
    // test passed against a scale it should have rejected.
    const gaps = (margin: string) => {
      if (margin === '') throw new Error('margin did not resolve; declare a longhand')
      return Number(/\*\s*([\d.]+)/.exec(margin)?.[1] ?? '1')
    }
    expect(gaps(marginTop)).toBeGreaterThan(gaps(marginBottom))
  })

  it('sets no monospace face on the prose, and keeps one for code', () => {
    const tiptap = paint('<p>a <code>b</code></p><pre><code>c</code></pre>')
    expect(getComputedStyle(tiptap).fontFamily).not.toContain('mono')
    expect(getComputedStyle(tiptap.querySelector('code')!).fontFamily).toContain('mono')
  })

  it('paints no ruling in the editor, and moves it to the collegebook sheet', () => {
    const tiptap = paint('<p>a</p>')
    expect(getComputedStyle(tiptap.parentElement!).backgroundImage).not.toContain(
      'gradient',
    )

    // Off the class page, which is a table of contents and never was a page
    // of notes, and onto the sheet, which is what ruled paper is for. Both
    // halves are asserted so this says "moved" rather than "deleted".
    const painted = (className: string) => {
      const element = document.createElement('div')
      element.className = className
      document.body.appendChild(element)
      mounted.push(element)
      return getComputedStyle(element).backgroundImage
    }
    expect(painted('page')).not.toContain('gradient')
    expect(painted('book-page')).toContain('gradient')
  })

  // Structural only, and jsdom leaves var() unresolved, which is what makes
  // these readable: the declarations are the assertion. Nothing here can say
  // where the rule lands on the paper or how wide the sheet comes out — that
  // needs layout, and jsdom has none.
  it('prints the margin rule on the sheet instead of at the pane edge', () => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    const sheet = document.createElement('div')
    sheet.className = 'book-page'
    document.body.appendChild(sheet)
    mounted.push(style, sheet)

    // The ruling is painted on the sheet, mixed from the book's own ink so it
    // stays faint against whatever paper the reader picks.
    expect(getComputedStyle(sheet).backgroundImage).toContain('var(--ruling)')
    expect(CSS).toContain('--ruling: color-mix(in srgb, var(--ink)')
    // The red rule is an element on the paper, placed by the inset setting,
    // rather than a layer at the pane's edge. jsdom computes no pseudo-element
    // styles, so the declaration is the assertion.
    expect(CSS).toContain('.book-page::before')
    expect(CSS).toContain('left: var(--rule-inset)')
    // A sheet has a width. Without one it spans the pane and the paper looks
    // like it carries on past the right of the screen.
    expect(getComputedStyle(sheet).maxWidth).not.toBe('none')

    // And the pane's own rule is off while a book is open, because two red
    // verticals read as a table rather than as a margin.
    expect(CSS).toContain('.content:has(.book)::before')
  })
})

describe('links', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const LINK = 'see [the docs](https://example.com) here'

  it('renders a link that would open in a new tab safely', async () => {
    const { container } = await open(LINK, false)
    const anchor = container.querySelector('a')!

    expect(anchor.getAttribute('href')).toBe('https://example.com')
    expect(anchor.getAttribute('target')).toBe('_blank')
    // The extension's default also carries nofollow, which is a publisher's
    // concern and means nothing in a private note.
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
  })

  // ProseMirror derives handleClick from its own mousedown/mouseup pair and
  // asks posAtCoords where the pointer landed, which needs layout jsdom does
  // not have. So the handler is driven through someProp — the same lookup
  // ProseMirror itself uses — with the event a real click would carry. What
  // this does not cover is ProseMirror's hit-testing, which is jsdom's gap
  // rather than the handler's.
  const clickLink = (editor: TipTap, container: HTMLElement, modifier: boolean) => {
    const anchor = container.querySelector('a')!
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: modifier,
    })
    // Dispatched first, so the event carries the anchor as its target the way
    // a real one does — target is read-only and only dispatch sets it.
    anchor.dispatchEvent(event)
    expect(event.target).toBe(anchor)
    return editor.view.someProp('handleClick', (f) => f(editor.view, 1, event))
  }

  it('opens in a new tab on Cmd or Ctrl click', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    const { editor, container } = await open(LINK, false)

    expect(clickLink(editor, container, true)).toBe(true)

    // noopener,noreferrer here as well as in rel: rel governs a navigation the
    // document starts, and a script-opened window is not one.
    expect(opened).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('places the cursor on a plain click instead of navigating', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    const { editor, container } = await open(LINK, false)

    // Not handled, so the click falls through to ProseMirror, which is what
    // puts the caret in the link — and the caret is what the bubble menu's
    // link input reads when a URL needs fixing.
    expect(clickLink(editor, container, false)).toBeFalsy()
    expect(opened).not.toHaveBeenCalled()

    // The proof that a caret in a link is reachable at all: the input the
    // bubble menu opens prefills from the link the selection sits in.
    await act(async () => {
      editor.commands.setTextSelection({ from: 5, to: 13 })
    })
    await act(async () => {
      screen.getByLabelText('Link').click()
    })
    expect((screen.getByLabelText('Link URL') as HTMLInputElement).value).toBe(
      'https://example.com',
    )
  })
})

// One list, two triggers, and the tests below reach the list through
// `data-command` rather than through a label, so "both paths run the same
// command" is asserted against the command's identity instead of against two
// strings that happen to match.
describe('block menu', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
  })

  const blockMenu = (container: HTMLElement) => container.querySelector('.block-menu')

  const options = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.block-menu [role="option"]')).map(
      (option) => option.getAttribute('data-command'),
    )

  const optionFor = (container: HTMLElement, id: string) =>
    container.querySelector(`.block-menu [data-command="${id}"]`) as HTMLElement

  // Through ProseMirror, one character at a time, because the detection reads
  // the text in front of the cursor and a whole string pasted in at once would
  // not prove that it holds up mid-word.
  const typeIn = async (editor: TipTap, text: string) => {
    for (const char of text) {
      await act(async () => {
        type(editor, char)
      })
    }
  }

  const caretAt = async (editor: TipTap, pos: number) => {
    await act(async () => {
      editor.commands.focus(null, SILENT)
      editor.commands.setTextSelection(pos)
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
  }

  const press = async (element: HTMLElement, key: string) => {
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      )
    })
  }

  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click()
    })
  }

  const tiptapIn = (container: HTMLElement) =>
    container.querySelector('.tiptap') as HTMLElement

  it('opens on `/` at the start of an empty paragraph', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)
    expect(blockMenu(container)).toBeNull()

    await typeIn(editor, '/')

    expect(blockMenu(container)).not.toBeNull()
  })

  // The mutation that matters, and the reason detection reads text rather than
  // listening for the `/` key. A `key === '/'` handler passes every other test
  // in this file and fails this one: a URL and a date both carry a slash that
  // no one wants a menu for.
  it('stays shut on `/` typed mid-word, and opens on `/` after a space', async () => {
    const { editor, container } = await open('see http:', false)
    await caretAt(editor, editor.state.doc.content.size - 1)

    await typeIn(editor, '/')
    expect(blockMenu(container)).toBeNull()
    await typeIn(editor, '/x')
    expect(blockMenu(container)).toBeNull()

    await typeIn(editor, ' /')
    expect(blockMenu(container)).not.toBeNull()
  })

  it('narrows the list as the filter is typed', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)

    await typeIn(editor, '/')
    expect(options(container).length).toBeGreaterThan(3)

    await typeIn(editor, 'head')
    expect(options(container)).toEqual(['heading1', 'heading2', 'heading3'])
  })

  // Typing a sentence that begins with a slash must not trap anyone in a menu.
  it('closes when the filter matches nothing', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)

    await typeIn(editor, '/head')
    expect(blockMenu(container)).not.toBeNull()

    await typeIn(editor, 'zzzz')
    expect(blockMenu(container)).toBeNull()
  })

  it('moves the selection with the arrow keys and runs the selected command', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)
    await typeIn(editor, '/head')

    expect(optionFor(container, 'heading1').getAttribute('aria-selected')).toBe('true')

    await press(tiptapIn(container), 'ArrowDown')
    expect(optionFor(container, 'heading2').getAttribute('aria-selected')).toBe('true')
    await press(tiptapIn(container), 'ArrowUp')
    expect(optionFor(container, 'heading1').getAttribute('aria-selected')).toBe('true')

    await press(tiptapIn(container), 'ArrowDown')
    await press(tiptapIn(container), 'ArrowDown')
    await press(tiptapIn(container), 'Enter')

    expect(blockMenu(container)).toBeNull()
    expect(editor.state.doc.firstChild?.type.name).toBe('heading')
    // The third row, so running the first one — or any fixed index — fails.
    expect(editor.state.doc.firstChild?.attrs.level).toBe(3)
  })

  // Escape leaves the slash where it was typed: it is literal text that
  // happened to open a menu, and closing the menu does not make it not text.
  it('closes on Escape, leaves the `/` in the document, and holds the key', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)
    await typeIn(editor, '/quo')

    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    await press(tiptapIn(container), 'Escape')
    window.removeEventListener('keydown', seen)

    expect(blockMenu(container)).toBeNull()
    expect(editor.state.doc.textContent).toBe('/quo')
    // App.tsx listens on the window and never asks whether anyone dealt with
    // the key, so an Escape that reaches it closes the note behind the menu.
    expect(seen).not.toHaveBeenCalled()

    // The half that makes Escape mean anything. The text still matches, so a
    // detection that only looks at the text reopens the menu on the very next
    // keystroke and there is no way out of it at all.
    await typeIn(editor, 't')
    expect(blockMenu(container)).toBeNull()
    expect(editor.state.doc.textContent).toBe('/quot')

    // Dismissed, not disabled: a fresh `/` somewhere else still opens.
    await typeIn(editor, ' /')
    expect(blockMenu(container)).not.toBeNull()
  })

  it('reopens on a fresh `/` typed where a dismissed one was', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)
    await typeIn(editor, '/quo')
    await press(tiptapIn(container), 'Escape')
    expect(blockMenu(container)).toBeNull()

    // Backed out and tried again at the same offset. A dismissal remembered by
    // position and never cleared leaves that spot dead for the rest of the
    // session, which is worse than not having Escape at all.
    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 5 })
      editor.commands.deleteSelection()
    })
    await typeIn(editor, '/')

    expect(blockMenu(container)).not.toBeNull()
  })

  it('removes the typed `/text` and inserts the block', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)
    await typeIn(editor, '/quote')

    await press(tiptapIn(container), 'Enter')

    expect(editor.state.doc.firstChild?.type.name).toBe('blockquote')
    expect(editor.state.doc.textContent).toBe('')
  })

  it('inserts below the current block from the + button, not at the cursor', async () => {
    const { editor, container } = await open('alpha', false)
    await caretAt(editor, 3)

    await click(container.querySelector('.block-add') as HTMLElement)
    await click(optionFor(container, 'heading1'))

    // Untouched, and in one piece: inserting at the cursor would have split it.
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(editor.state.doc.firstChild?.textContent).toBe('alpha')
    // Second, so it went below. Third is StarterKit's trailing paragraph,
    // which it adds after any document ending in a heading.
    expect(editor.state.doc.child(1).type.name).toBe('heading')
  })

  it('produces the same block from both triggers for the same command', async () => {
    const slash = await open('', false)
    await caretAt(slash.editor, 1)
    await typeIn(slash.editor, '/code')
    await press(tiptapIn(slash.container), 'Enter')
    const typed = slash.editor.state.selection.$from.parent.type.name
    cleanup()

    const button = await open('', false)
    await caretAt(button.editor, 1)
    await click(button.container.querySelector('.block-add') as HTMLElement)
    await click(optionFor(button.container, 'codeBlock'))
    const clicked = button.editor.state.selection.$from.parent.type.name

    expect(typed).toBe('codeBlock')
    expect(clicked).toBe(typed)
  })

  // A block you have to click into is a block that failed.
  it('leaves the cursor inside a code block', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)
    await typeIn(editor, '/code')
    await press(tiptapIn(container), 'Enter')

    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock')
  })

  it('leaves the cursor inside a table', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)
    await typeIn(editor, '/table')
    await press(tiptapIn(container), 'Enter')

    let inTable = false
    for (let depth = editor.state.selection.$from.depth; depth > 0; depth -= 1) {
      if (editor.state.selection.$from.node(depth).type.name === 'table') inTable = true
    }
    expect(inTable).toBe(true)
  })

  it('does not open while the formula source field is open', async () => {
    const { editor, container } = await open('pick me $x^2$ here', false)
    await act(async () => {
      container
        .querySelector('[data-type="inline-math"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('.math-source')).not.toBeNull()

    await act(async () => {
      editor.commands.setTextSelection(1)
    })
    await typeIn(editor, '/')

    // Start of a paragraph, so without the guard this is exactly the case that
    // opens the menu on top of the field holding the cursor.
    expect(blockMenu(container)).toBeNull()
  })

  // The cursor is deliberately parked behind text that already matches, so the
  // emptiness check is the only thing holding the menu shut. Relying on the
  // collapse that typing causes tests nothing: it makes the selection empty
  // before the guard is ever consulted.
  it('stays shut while a selection is open, even behind a matching `/`', async () => {
    const { editor, container } = await open('/quo bold me please', false)
    await act(async () => {
      editor.commands.focus(null, SILENT)
      editor.commands.setTextSelection({ from: 5, to: 9 })
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))

    expect(container.querySelector('.bubble-menu')).not.toBeNull()
    expect(blockMenu(container)).toBeNull()
  })

  it('takes over from the bubble menu when typing collapses the selection', async () => {
    const { editor, container } = await open('bold me please', false)
    await act(async () => {
      editor.commands.focus(null, SILENT)
      editor.commands.setTextSelection({ from: 1, to: 5 })
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(container.querySelector('.bubble-menu')).not.toBeNull()

    await typeIn(editor, '/')

    expect(container.querySelector('.bubble-menu')).toBeNull()
    expect(blockMenu(container)).not.toBeNull()
  })

  // A <button> in the margin is not contenteditable and is not an input, so
  // App.tsx's guard does not cover it and `n` would create a note.
  it('keeps keys off the window while the + menu is open', async () => {
    const { editor, container } = await open('alpha', false)
    await caretAt(editor, 3)
    await click(container.querySelector('.block-add') as HTMLElement)
    // Wherever the focus actually is, which is where a real key lands. Sent to
    // the menu element instead, this passed while the menu never had focus
    // and Escape went on to close the note.
    expect(document.activeElement).toBe(blockMenu(container))

    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    await press(document.activeElement as HTMLElement, 'n')
    await press(document.activeElement as HTMLElement, 'Escape')
    window.removeEventListener('keydown', seen)

    expect(seen).not.toHaveBeenCalled()
    expect(blockMenu(container)).toBeNull()
  })

  // The slash menu is driven from the document's own key handler, so taking
  // the focus away from the text would stop the typing that filters it.
  it('leaves the focus in the text while the slash menu is open', async () => {
    const { editor, container } = await open('', false)
    await caretAt(editor, 1)
    await typeIn(editor, '/')
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))

    expect(blockMenu(container)).not.toBeNull()
    expect(document.activeElement).toBe(tiptapIn(container))
  })
})

describe('topic highlight', () => {
  const OTHER = '0199a0f0-0000-7000-8000-000000000002'
  const BODY =
    '# Diskrétna matematika\n\n## Množiny\n\nText.\n\n## Relácie\n\nViac textu.'

  const marked = (container: HTMLElement) =>
    [...container.querySelectorAll('.topic-marked')].map((node) => node.textContent)

  beforeEach(async () => {
    await db.notes.clear()
    await db.deadlines.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('marks a heading a deadline names in this note and nothing else', async () => {
    // Relácie is named too, but in another note: matching on the heading text
    // alone would mark it here.
    await createDeadline({
      title: 'Písomka',
      dueAt: '2026-10-01T00:00:00.000Z',
      topics: [
        { noteId: ID, heading: 'Množiny' },
        { noteId: OTHER, heading: 'Relácie' },
      ],
    })

    const { container } = await open(BODY, false)

    await waitFor(() => expect(marked(container)).toEqual(['Množiny']))
  })

  it('marks a heading in an open note when a deadline is added elsewhere', async () => {
    const { container } = await open(BODY, false)
    expect(marked(container)).toEqual([])

    await act(async () => {
      await createDeadline({
        title: 'Zápočet',
        dueAt: '2026-10-08T00:00:00.000Z',
        topics: [{ noteId: ID, heading: 'Relácie' }],
      })
    })

    await waitFor(() => expect(marked(container)).toEqual(['Relácie']))
  })

  it('keeps the highlight out of the markdown', () => {
    const editor = new BareEditor({
      element: document.createElement('div'),
      extensions: editorExtensions(),
      content: BODY,
      contentType: 'markdown',
    })

    markTopics(editor, { names: new Set(['Množiny']), flash: 'Relácie' })

    // Both painted, so the assertion below is about a highlighted note.
    expect(editor.view.dom.querySelectorAll('.topic-marked')).toHaveLength(2)
    expect(editor.getMarkdown()).toBe(BODY)
    editor.destroy()
  })
})

describe('block controls', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
  })

  const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |'

  const controlsIn = (container: HTMLElement) => container.querySelector('.block-controls')

  const item = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLButtonElement>(`.block-controls [data-command="${id}"]`)

  const commandsIn = (container: HTMLElement, group: string) =>
    Array.from(
      container.querySelectorAll(`.block-controls [aria-label="${group}"] [data-command]`),
    ).map((button) => button.getAttribute('data-command'))

  const posOf = (editor: TipTap, text: string) => {
    let found = -1
    editor.state.doc.descendants((node, pos) => {
      if (found === -1 && node.isText && node.text!.includes(text)) {
        found = pos + node.text!.indexOf(text)
      }
    })
    if (found === -1) throw new Error(`no ${text} in the document`)
    return found
  }

  const caretAt = async (editor: TipTap, pos: number) => {
    await act(async () => {
      editor.commands.focus(null, SILENT)
      editor.commands.setTextSelection(pos)
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
  }

  const press = async (element: HTMLElement, key: string) => {
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      )
    })
  }

  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click()
    })
  }

  const openAt = async (bodyMd: string, text: string) => {
    const opened = await open(bodyMd, false)
    await caretAt(opened.editor, posOf(opened.editor, text))
    await click(opened.container.querySelector('.block-handle') as HTMLElement)
    return opened
  }

  const run = async (container: HTMLElement, id: string) => {
    const button = item(container, id)
    if (button === null) throw new Error(`no ${id} in the menu`)
    await click(button)
  }

  // The table as its cells' text, with whether the first row is a header.
  const grid = (editor: TipTap) => {
    let table: ProseMirrorNodeLike | null = null
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'table') table = node
      return table === null
    })
    if (table === null) return null
    const rows: ProseMirrorNodeLike[] = []
    ;(table as ProseMirrorNodeLike).forEach((row) => rows.push(row))
    const cells = rows.map((row) => {
      const texts: string[] = []
      row.forEach((cell) => texts.push(cell.textContent))
      return texts
    })
    return { cells, header: rows[0]!.firstChild!.type.name === 'tableHeader' }
  }

  it('deletes the block the handle is beside', async () => {
    const { editor, container } = await openAt('alpha\n\nbeta\n\ngamma', 'beta')

    await run(container, 'delete')

    expect(editor.getMarkdown()).toBe('alpha\n\ngamma')
    expect(controlsIn(container)).toBeNull()
  })

  it('duplicates the block, identical, directly below it', async () => {
    const { editor, container } = await openAt('# Title **bold**\n\nbody', 'Title')

    await run(container, 'duplicate')

    const { doc } = editor.state
    expect(doc.child(1).eq(doc.child(0))).toBe(true)
    expect(doc.child(2).textContent).toBe('body')
    expect(editor.getMarkdown()).toBe('# Title **bold**\n\n# Title **bold**\n\nbody')
  })

  it('moves a block down and up, and leaves the option out at each end', async () => {
    const { editor, container } = await openAt('alpha\n\nbeta\n\ngamma', 'alpha')
    expect(item(container, 'moveUp')).toBeNull()
    expect(item(container, 'moveDown')).not.toBeNull()

    await run(container, 'moveDown')
    expect(editor.getMarkdown()).toBe('beta\n\nalpha\n\ngamma')
    // The cursor went with the block, so a second move moves the same one.
    expect(editor.state.selection.$from.parent.textContent).toBe('alpha')

    await caretAt(editor, posOf(editor, 'gamma'))
    await click(container.querySelector('.block-handle') as HTMLElement)
    expect(item(container, 'moveDown')).toBeNull()
    expect(item(container, 'moveUp')).not.toBeNull()

    await run(container, 'moveUp')
    expect(editor.getMarkdown()).toBe('beta\n\ngamma\n\nalpha')
  })

  it('turns a block into another through the shared command list', async () => {
    const { editor, container } = await openAt('plain words', 'plain')
    expect(commandsIn(container, 'Turn into')).toEqual(TURN_INTO.map((command) => command.id))

    const heading2 = TURN_INTO.find((command) => command.id === 'heading2')!
    const ran = vi.spyOn(heading2, 'run')
    await run(container, 'heading2')

    expect(ran).toHaveBeenCalledOnce()
    // Trimmed: StarterKit adds a trailing paragraph after a final heading.
    expect(editor.getMarkdown().trimEnd()).toBe('## plain words')
    ran.mockRestore()
  })

  it('turns a quote back into a paragraph outside the quote', async () => {
    const { editor, container } = await openAt('> quoted', 'quoted')

    await run(container, 'paragraph')

    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(editor.getMarkdown().trimEnd()).toBe('quoted')
  })

  // By the label a person reads, not the command id, so a label wired to the
  // wrong command fails here.
  it.each([
    ['Insert row above', [['a', 'b'], ['', ''], ['1', '2']], true],
    ['Insert row below', [['a', 'b'], ['1', '2'], ['', '']], true],
    ['Insert column left', [['', 'a', 'b'], ['', '1', '2']], true],
    ['Insert column right', [['a', '', 'b'], ['1', '', '2']], true],
    ['Delete row', [['a', 'b']], true],
    ['Delete column', [['b'], ['2']], true],
  ])('%s does what it says to the table', async (label, cells, header) => {
    const { editor, container } = await openAt(TABLE, '1')
    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.block-controls button'),
    ).find((candidate) => candidate.textContent === label)

    await click(button!)

    expect(grid(editor)).toEqual({ cells, header })
  })

  it('has no Toggle header row, which would save an empty header', async () => {
    const { container } = await openAt(TABLE, '1')

    expect(item(container, 'toggleHeaderRow')).toBeNull()
    const labels = Array.from(container.querySelectorAll('.block-controls button')).map(
      (button) => button.textContent,
    )
    expect(labels).toContain('Delete table')
    expect(labels).not.toContain('Toggle header row')
  })

  it('deletes the table', async () => {
    const { editor, container } = await openAt(`before\n\n${TABLE}\n\nafter`, '1')

    await run(container, 'deleteTable')

    expect(grid(editor)).toBeNull()
    expect(editor.getMarkdown()).toBe('before\n\nafter')
  })

  // Present and disabled are both "not clickable", so this asserts each half:
  // the row is in the menu, and it is the disabled attribute keeping it inert.
  it('disables, and does not hide, what cannot apply to a one-cell table', async () => {
    const { editor, container } = await openAt('| a |\n| --- |', 'a')

    for (const id of ['deleteRow', 'deleteColumn']) {
      const button = item(container, id)
      expect(button).not.toBeNull()
      expect(button!.disabled).toBe(true)
    }
    expect(item(container, 'addRowAfter')!.disabled).toBe(false)
    expect(item(container, 'deleteTable')!.disabled).toBe(false)
    expect(commandsIn(container, 'Table')).toHaveLength(7)

    await click(item(container, 'deleteRow')!)
    expect(grid(editor)).toEqual({ cells: [['a']], header: true })
  })

  it('has no table section outside a table, and no Turn into inside one', async () => {
    const outside = await openAt(`words\n\n${TABLE}`, 'words')
    expect(controlsIn(outside.container)).not.toBeNull()
    expect(commandsIn(outside.container, 'Table')).toEqual([])
    expect(commandsIn(outside.container, 'Turn into')).not.toEqual([])
    cleanup()

    const inside = await openAt(`words\n\n${TABLE}`, '2')
    expect(commandsIn(inside.container, 'Table')).toHaveLength(7)
    expect(commandsIn(inside.container, 'Turn into')).toEqual([])
  })

  // The common case: the pointer is over a table the cursor is not in. The
  // handle has to bring the cursor into the table, or the table commands are
  // unreachable exactly when someone reaches for them.
  it('moves the cursor into a table it was not in, and shows the table section', async () => {
    const { editor, container } = await open(`words\n\n${TABLE}`, false)
    await caretAt(editor, posOf(editor, 'words'))
    const tableAt = editor.state.doc.child(1)
    expect(tableAt.type.name).toBe('table')
    const over = editor.state.doc.child(0).nodeSize + 1
    const hover = vi
      .spyOn(editor.view, 'posAtCoords')
      .mockReturnValue({ pos: over, inside: -1 })
    await act(async () => {
      container
        .querySelector('.editor')!
        .dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    })
    hover.mockRestore()

    await click(container.querySelector('.block-handle') as HTMLElement)

    expect(editor.state.selection.$from.parent.textContent).toBe('a')
    expect(commandsIn(container, 'Table')).toHaveLength(7)
    await run(container, 'addRowAfter')
    expect(grid(editor)!.cells).toEqual([['a', 'b'], ['', ''], ['1', '2']])
  })

  it('does not open while the formula source field is open', async () => {
    const { editor, container } = await open('pick me $x^2$ here', false)
    await caretAt(editor, 2)
    await act(async () => {
      container
        .querySelector('[data-type="inline-math"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('.math-source')).not.toBeNull()

    await click(container.querySelector('.block-handle') as HTMLElement)

    expect(controlsIn(container)).toBeNull()
  })

  it('closes the bubble menu and keeps it shut while open', async () => {
    const { editor, container } = await open('bold me please', false)
    await act(async () => {
      editor.commands.focus(null, SILENT)
      editor.commands.setTextSelection({ from: 1, to: 5 })
    })
    // TipTap focuses on the next animation frame. A focus still pending when
    // the menu opens takes the focus back out of it, and the menu closes on
    // that blur — which made this fail when run on its own.
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(container.querySelector('.bubble-menu')).not.toBeNull()

    await click(container.querySelector('.block-handle') as HTMLElement)
    expect(controlsIn(container)).not.toBeNull()
    expect(container.querySelector('.bubble-menu')).toBeNull()

    await act(async () => {
      editor.commands.setTextSelection({ from: 6, to: 8 })
    })
    expect(container.querySelector('.bubble-menu')).toBeNull()
  })

  it('keeps `n` off the window, and Escape hands focus back to the block', async () => {
    const { editor, container } = await openAt('alpha\n\nbeta', 'beta')
    const menu = controlsIn(container) as HTMLElement
    // Focus in the menu is what keeps the keys out of the document at all.
    expect(menu.contains(document.activeElement)).toBe(true)
    const before = editor.getMarkdown()

    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    await press(document.activeElement as HTMLElement, 'n')
    await press(document.activeElement as HTMLElement, 'Escape')
    window.removeEventListener('keydown', seen)

    expect(seen).not.toHaveBeenCalled()
    expect(controlsIn(container)).toBeNull()
    expect(editor.getMarkdown()).toBe(before)
    // TipTap's focus command lands on the next animation frame.
    await settle()
    expect(document.activeElement).toBe(container.querySelector('.tiptap'))
    expect(editor.state.selection.$from.parent.textContent).toBe('beta')
  })
})

describe('highlight button', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
  })

  const select = async (editor: TipTap, from: number, to: number) => {
    await act(async () => {
      editor.commands.focus(null, SILENT)
      editor.commands.setTextSelection({ from, to })
    })
  }

  const button = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('.bubble-menu [aria-label="Highlight"]')!

  const press = async (container: HTMLElement) => {
    await act(async () => {
      button(container).click()
    })
  }

  const runs = (editor: TipTap) => {
    const found: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'highlight')) {
        found.push(node.text!)
      }
    })
    return found
  }

  it('applies, reflects, and removes a highlight', async () => {
    const { editor, container } = await open('mark these words', false)
    await select(editor, 6, 11)
    expect(button(container).getAttribute('aria-pressed')).toBe('false')

    await press(container)
    expect(runs(editor)).toEqual(['these'])
    expect(button(container).getAttribute('aria-pressed')).toBe('true')

    await press(container)
    expect(runs(editor)).toEqual([])
    expect(button(container).getAttribute('aria-pressed')).toBe('false')
  })

  // The trimming path. Plain spaces at the ends do not tell the two commands
  // apart — the serialiser moves them outside the mark either way — but a
  // selection across an inline formula does: the generic mark command saves
  // `==pay ==$x$==== now`, which reopens with a literal `==` in the sentence.
  // Asserted on what is saved and on a fresh editor built from it, because the
  // in-memory mark exists either way.
  it('round-trips a highlight applied across an inline formula', async () => {
    const { editor, container } = await open('pay $x$ now', false)
    await select(editor, 1, 7)

    await press(container)

    const saved = editor.getMarkdown()
    expect(saved).toBe('==pay== $x$ now')
    const element = document.createElement('div')
    document.body.appendChild(element)
    const again = new BareEditor({
      element,
      extensions: editorExtensions(),
      content: saved,
      contentType: 'markdown',
    })
    expect(runs(again)).toEqual(['pay'])
    expect(again.state.doc.textContent).not.toContain('=')
    expect(again.getMarkdown()).toBe(saved)
    again.destroy()
    element.remove()
  })

  // isActive judges the untrimmed selection and says no here, while pressing
  // the button would remove the mark. The pressed state has to agree with
  // what pressing does.
  it('shows as pressed over a highlight selected with a trailing space', async () => {
    const { editor, container } = await open('mark ==these== words', false)
    await select(editor, 6, 12)

    expect(button(container).getAttribute('aria-pressed')).toBe('true')
    await press(container)
    expect(runs(editor)).toEqual([])
  })
})

describe('block controls placement', () => {
  beforeEach(async () => {
    await db.notes.clear()
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
  })

  const BODY = 'alpha\n\nbeta\n\n> one\n>\n> two\n>\n> three'

  // jsdom has no layout, so every position measures as 0 and a test could not
  // tell one block's controls from another's. Ten pixels per position gives
  // each block its own height, and the handle's top says which it is beside.
  const layout = (editor: TipTap) =>
    vi.spyOn(editor.view, 'coordsAtPos').mockImplementation((pos) => ({
      top: pos * 10,
      bottom: pos * 10 + 10,
      left: 0,
      right: 0,
    }))

  const posOf = (editor: TipTap, text: string) => {
    let found = -1
    editor.state.doc.descendants((node, pos) => {
      if (found === -1 && node.isText && node.text!.includes(text)) {
        found = pos + node.text!.indexOf(text)
      }
    })
    return found
  }

  // Where the controls belong for the index-th top-level block: its first
  // position inside, which is what anchorAt measures.
  const topOf = (editor: TipTap, index: number) =>
    (editor.state.doc.resolve(0).posAtIndex(index, 0) + 1) * 10

  const handleTop = (container: HTMLElement) => {
    const handle = container.querySelector<HTMLElement>('.block-handle')!
    const add = container.querySelector<HTMLElement>('.block-add')!
    expect(add.style.top).toBe(handle.style.top)
    return parseFloat(handle.style.top)
  }

  const surface = (container: HTMLElement) => container.querySelector('.editor')!

  const hover = async (container: HTMLElement, editor: TipTap, pos: number) => {
    const at = vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos, inside: -1 })
    await act(async () => {
      surface(container).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    })
    at.mockRestore()
  }

  // React builds mouseleave out of mouseout with a target outside the element.
  const leave = async (container: HTMLElement) => {
    await act(async () => {
      surface(container).dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      )
    })
  }

  const caretAt = async (editor: TipTap, pos: number) => {
    await act(async () => {
      editor.commands.focus(null, SILENT)
      editor.commands.setTextSelection(pos)
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
  }

  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click()
    })
  }

  it('sits beside the hovered block, moves with the pointer, and ignores typing', async () => {
    const { editor, container } = await open(BODY, false)
    layout(editor)
    await caretAt(editor, posOf(editor, 'alpha') + 2)

    await hover(container, editor, posOf(editor, 'beta'))
    expect(handleTop(container)).toBe(topOf(editor, 1))

    await hover(container, editor, posOf(editor, 'one'))
    expect(handleTop(container)).toBe(topOf(editor, 2))

    // Typed above the hovered quote, which pushes it down by three. The stored
    // position has to move with it, or it now points into beta.
    await act(async () => {
      type(editor, 'xyz')
    })
    expect(editor.state.doc.firstChild!.textContent).toBe('alxyzpha')
    expect(handleTop(container)).toBe(topOf(editor, 2))
  })

  // A paragraph and a quote of several lines both put the controls at their
  // first line, wherever inside them the pointer is.
  it('aligns to the top of the hovered block, not the line under the pointer', async () => {
    const { editor, container } = await open(BODY, false)
    layout(editor)

    await hover(container, editor, posOf(editor, 'three') + 2)

    expect(handleTop(container)).toBe(topOf(editor, 2))
    expect(handleTop(container)).not.toBe((posOf(editor, 'three') + 2) * 10)
  })

  it('follows the cursor once the pointer leaves the editor', async () => {
    const { editor, container } = await open(BODY, false)
    layout(editor)
    await caretAt(editor, posOf(editor, 'beta'))
    expect(handleTop(container)).toBe(topOf(editor, 1))

    await hover(container, editor, posOf(editor, 'two'))
    expect(handleTop(container)).toBe(topOf(editor, 2))

    await leave(container)
    expect(handleTop(container)).toBe(topOf(editor, 1))

    await caretAt(editor, posOf(editor, 'alpha'))
    expect(handleTop(container)).toBe(topOf(editor, 0))
  })

  // Both menus put the cursor in their block, so the pointer is not the only
  // thing to hold off: the cursor moving while a menu is open — a pull
  // replacing the note does that — must not take the controls with it either.
  it.each([
    ['block options', '.block-handle'],
    ['insert block', '.block-add'],
  ])('stays beside the block the %s menu was opened on', async (_name, trigger) => {
    const { editor, container } = await open(BODY, false)
    layout(editor)
    await caretAt(editor, posOf(editor, 'alpha'))
    await hover(container, editor, posOf(editor, 'beta'))
    await click(container.querySelector(trigger) as HTMLElement)
    expect(container.querySelector('.block-controls, .block-menu')).not.toBeNull()

    await hover(container, editor, posOf(editor, 'three'))
    expect(handleTop(container)).toBe(topOf(editor, 1))

    await act(async () => {
      editor.commands.setTextSelection(posOf(editor, 'alpha'))
    })
    expect(handleTop(container)).toBe(topOf(editor, 1))

    await leave(container)
    expect(handleTop(container)).toBe(topOf(editor, 1))

    // With the pointer gone the controls would otherwise follow the cursor.
    await act(async () => {
      editor.commands.setTextSelection(posOf(editor, 'two'))
    })
    expect(handleTop(container)).toBe(topOf(editor, 1))
    expect(container.querySelector('.block-controls, .block-menu')).not.toBeNull()
  })

  // A menu opened against a document a pull has since replaced would act on
  // whatever block the cursor was clamped into, which is not the one it sits
  // beside. The hovered position belongs to the old document as well.
  it.each([
    ['block options', '.block-handle'],
    ['insert block', '.block-add'],
  ])('closes the %s menu when a pull replaces the note', async (_name, trigger) => {
    const { editor, container } = await open('alpha\n\nbeta', false)
    layout(editor)
    await caretAt(editor, posOf(editor, 'beta') + 2)
    await hover(container, editor, posOf(editor, 'beta') + 2)
    await click(container.querySelector(trigger) as HTMLElement)
    expect(container.querySelector('.block-controls, .block-menu')).not.toBeNull()

    await remoteChange('omega')
    await settle()

    expect(editor.getMarkdown()).toBe('omega')
    expect(editor.state.selection.$from.parent.textContent).toBe('omega')
    expect(container.querySelector('.block-controls, .block-menu')).toBeNull()
    // Already beside the block the cursor was clamped into, not left where
    // the menu was until something else moves them.
    expect(handleTop(container)).toBe(topOf(editor, 0))

    await remoteChange('one\n\ntwo\n\nthree')
    await settle()
    await caretAt(editor, posOf(editor, 'one'))
    expect(handleTop(container)).toBe(topOf(editor, 0))
  })

  // A jump, not a slide. Read through the real stylesheet so a transition
  // added to either rule, or to a rule that also matches them, is caught.
  it('does not animate the controls between blocks', async () => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    const { container } = await open(BODY, false)

    for (const selector of ['.block-handle', '.block-add']) {
      const computed = getComputedStyle(container.querySelector(selector)!)
      expect(['', 'none', '0s', 'all 0s ease 0s']).toContain(computed.transition)
    }
    style.remove()
  })
})

describe('line breaks', () => {
  const build = (content: string) => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    return new BareEditor({
      element,
      extensions: editorExtensions(),
      content,
      contentType: 'markdown',
    })
  }

  // Through the same handleKeyDown chain a real key goes through, so the
  // priority between this binding and StarterKit's is what is under test.
  const enter = (editor: TipTap, shiftKey = false) =>
    editor.view.someProp('handleKeyDown', (f) =>
      f(
        editor.view,
        new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, shiftKey }),
      ),
    )

  const typeAt = (editor: TipTap, text: string) => {
    for (const char of text) type(editor, char)
  }

  // Each top-level block as its type and text, with [br] for a line break, so
  // a break and a block boundary cannot be mistaken for each other.
  const shape = (editor: TipTap) => {
    const blocks: string[] = []
    editor.state.doc.forEach((block) => {
      let text = ''
      block.descendants((node) => {
        if (node.type.name === 'hardBreak') text += '[br]'
        else if (node.isText) text += node.text
        else if (node.isTextblock && text !== '') text += '|'
      })
      blocks.push(`${block.type.name}:${text}`)
    })
    return blocks
  }

  const reopened = (editor: TipTap) => {
    const again = build(editor.getMarkdown())
    const blocks = shape(again)
    again.destroy()
    return blocks
  }

  const endOf = (editor: TipTap) => editor.state.doc.content.size - 1

  it('breaks the line on Enter in a paragraph, and saves it as a trailing backslash', () => {
    const editor = build('one')
    editor.commands.setTextSelection(endOf(editor))

    enter(editor)
    typeAt(editor, 'two')

    expect(shape(editor)).toEqual(['paragraph:one[br]two'])
    expect(editor.getMarkdown()).toBe('one\\\ntwo')
    expect(reopened(editor)).toEqual(['paragraph:one[br]two'])
  })

  it('starts a new block on Shift+Enter in a paragraph', () => {
    const editor = build('one')
    editor.commands.setTextSelection(endOf(editor))

    enter(editor, true)
    typeAt(editor, 'two')

    expect(shape(editor)).toEqual(['paragraph:one', 'paragraph:two'])
  })

  // The iPad's on-screen keyboard does not reliably send Shift with Return,
  // so this is the only way to a new block there.
  it('turns Enter on an empty line into a new block, dropping the break', () => {
    const atEnd = build('one')
    atEnd.commands.setTextSelection(endOf(atEnd))
    enter(atEnd)
    enter(atEnd)
    typeAt(atEnd, 'two')
    expect(shape(atEnd)).toEqual(['paragraph:one', 'paragraph:two'])

    // An empty line between two others: both breaks around it go, and the
    // block boundary takes their place.
    const between = build('one\\\n\\\nthree')
    expect(shape(between)).toEqual(['paragraph:one[br][br]three'])
    between.commands.setTextSelection(5)
    enter(between)
    expect(shape(between)).toEqual(['paragraph:one', 'paragraph:three'])
  })

  it('leaves a quote the way it always did, through an empty paragraph', () => {
    const editor = build('> quoted')
    editor.commands.setTextSelection(endOf(editor) - 1)

    enter(editor)
    enter(editor)
    expect(shape(editor)).toEqual(['blockquote:quoted|', 'paragraph:'])
    enter(editor)
    typeAt(editor, 'out')

    expect(shape(editor)).toEqual(['blockquote:quoted', 'paragraph:out', 'paragraph:'])
  })

  // A markdown heading is one line: `# tit\` + `le` reopens as a heading and
  // a paragraph. So neither key may put a break in one. The trailing empty
  // paragraph is StarterKit's, after any document that ends in a heading.
  it.each([false, true])('starts a new block from a heading, shift %s', (shift) => {
    const editor = build('# title')
    editor.commands.setTextSelection(4)

    enter(editor, shift)

    expect(shape(editor)).toEqual(['heading:tit', 'heading:le', 'paragraph:'])
  })

  it('leaves list items, code blocks and table cells as they were', () => {
    const list = build('- item')
    list.commands.setTextSelection(endOf(list) - 1)
    enter(list)
    typeAt(list, 'next')
    expect(shape(list)).toEqual(['bulletList:item|next', 'paragraph:'])
    enter(list, true)
    expect(shape(list)).toEqual(['bulletList:item|next[br]', 'paragraph:'])

    const code = build('```\nx\n```')
    code.commands.setTextSelection(2)
    enter(code)
    expect(code.state.doc.firstChild!.textContent).toBe('x\n')

    const table = build('| a | b |\n| --- | --- |\n| 1 | 2 |')
    table.commands.setTextSelection(5)
    enter(table)
    expect(shape(table)[0]).toBe('table:a||b|1|2')
  })

  it('reads a two-space break as a break and saves it with a backslash', () => {
    const editor = build('one  \ntwo')

    expect(shape(editor)).toEqual(['paragraph:one[br]two'])
    expect(editor.getMarkdown()).toBe('one\\\ntwo')
  })

  // A backslash that ends a paragraph is a literal backslash, so a break left
  // at the end — which is where the cursor sits after Enter — is not saved.
  it('does not save a break at the end of a paragraph', () => {
    const editor = build('one\n\nnext')
    editor.commands.setTextSelection(4)
    enter(editor)

    expect(shape(editor)).toEqual(['paragraph:one[br]', 'paragraph:next'])
    expect(editor.getMarkdown()).toBe('one\n\nnext')
    expect(reopened(editor)).toEqual(['paragraph:one', 'paragraph:next'])
  })

  // After a break the next line is still inside the paragraph, and a line
  // that starts like a list, a heading or a setext underline would end it on
  // the way back in: `a\` + `- b` reopens as a paragraph and a list.
  it.each(['- b', '+ b', '* b', '1. b', '2) b', '# b', '###', '=', '---', '> b', '- [ ] b'])(
    'keeps %j after a break as text through a save',
    (line) => {
      const editor = build('a')
      editor.commands.setTextSelection(2)
      enter(editor)
      editor.commands.insertContent({ type: 'text', text: line })

      expect(shape(editor)).toEqual([`paragraph:a[br]${line}`])
      expect(reopened(editor)).toEqual([`paragraph:a[br]${line}`])
    },
  )

  it('keeps a break inside a table cell inside the table', () => {
    const editor = build('| a | b |\n| --- | --- |\n| 1 | 2 |')
    editor.commands.setTextSelection(5)
    enter(editor, true)
    typeAt(editor, 'x')

    expect(shape(editor)).toEqual(['table:a[br]x|b|1|2', 'paragraph:'])
    expect(reopened(editor)).toEqual(['table:a[br]x|b|1|2', 'paragraph:'])

    // A cell holding two paragraphs is written without the paragraph
    // renderer, straight from the table's, so it is its own case.
    enter(editor)
    enter(editor, true)
    typeAt(editor, 'y')
    expect(editor.getMarkdown()).not.toContain('\\<br>')
    expect(reopened(editor)[0]).toContain('[br]y')
    expect(reopened(editor)[0]).not.toContain('<br>')
  })

  describe('markdown rules after a break', () => {
    // Everything the stock rules turn into a block at the start of a
    // paragraph. `- [ ] ` is absent on purpose: the stock rules make it a
    // bullet whose text is `[ ] `, and a line after a break does the same.
    const MARKERS = ['- ', '+ ', '* ', '1. ', '3. ', '> ', '# ', '## ', '### ', '#### ', '##### ', '###### ', '[ ] ', '[x] ']

    // What the stock rules make of `typed` at the start of the paragraph `zz`.
    const atBlockStart = (typed: string) => {
      const editor = build('first\n\nzz')
      editor.commands.setTextSelection(8)
      typeAt(editor, typed)
      const content = editor.getJSON().content!.slice(0, 2)
      editor.destroy()
      return content
    }

    // The same, typed on the line after a break: `first` + break + `zz`.
    const afterBreak = (typed: string, after = '') => {
      const editor = build(`first\\\nzz${after}`)
      expect(shape(editor)[0]).toBe('paragraph:first[br]zz')
      editor.commands.setTextSelection(7)
      typeAt(editor, typed)
      return editor
    }

    const backspace = (editor: TipTap) =>
      editor.view.someProp('handleKeyDown', (f) =>
        f(editor.view, new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8 })),
      )

    it.each(MARKERS)('turns %j after a break into the block it makes at a block start', (marker) => {
      const editor = afterBreak(`${marker}x`)

      expect(editor.getJSON().content!.slice(0, 2)).toEqual(atBlockStart(`${marker}x`))
    })

    it.each(['a - b', 'x + y', 'x * y', 'x 1. y', 'see # 3', 'a > b', 'a [ ] b'])(
      'leaves %j alone, because the marker is not at the start of the line',
      (typed) => {
        const editor = afterBreak(typed)

        expect(shape(editor)).toEqual([`paragraph:first[br]${typed}zz`])
      },
    )

    it.each(['####### ', '1) ', '- [ ] '])('does what a block start does with %j', (typed) => {
      const editor = afterBreak(typed)
      const expected = atBlockStart(typed)

      expect(editor.getJSON().content![0]!.type).toBe('paragraph')
      if (expected[1]!.type === 'paragraph') {
        expect(shape(editor)).toEqual([`paragraph:first[br]${typed}zz`])
      } else {
        expect(editor.getJSON().content!.slice(0, 2)).toEqual(expected)
      }
    })

    // The stock rules at the start of a paragraph, undone: the marker is now
    // the paragraph's own first text, and unescaped `- zz` reopens as a list.
    // Not the last block, for the reason the Backspace tests above give.
    it.each(MARKERS)('keeps a literal %j at the start of a paragraph through a save', (marker) => {
      const editor = build('first\n\nzz\n\nlast')
      editor.commands.setTextSelection(8)
      typeAt(editor, marker)
      expect(shape(editor)[1]).not.toBe('paragraph:zz')

      backspace(editor)

      const literal = ['paragraph:first', `paragraph:${marker}zz`, 'paragraph:last']
      expect(shape(editor)).toEqual(literal)
      expect(reopened(editor)).toEqual(literal)
    })

    // A soft line break in markdown written elsewhere stays a newline in the
    // text, and the editor shows it as a new line, so a marker there opens one.
    it('treats a newline kept from imported markdown as a line start too', () => {
      const editor = build('first\nzz\n\nlast')
      expect(editor.state.doc.firstChild!.textContent).toBe('first\nzz')
      editor.commands.setTextSelection(7)

      typeAt(editor, '- ')

      expect(shape(editor)).toEqual(['paragraph:first', 'bulletList:zz', 'paragraph:last'])
    })

    // Nothing before the break means nothing to keep: no empty paragraph is
    // left above the new block.
    it('leaves no empty paragraph when the break opens the paragraph', () => {
      const editor = build('zz\n\nlast')
      editor.commands.setTextSelection(1)
      editor.commands.setHardBreak()
      expect(shape(editor)[0]).toBe('paragraph:[br]zz')

      typeAt(editor, '- ')

      expect(shape(editor)).toEqual(['bulletList:zz', 'paragraph:last'])
    })

    // A break there comes from Shift+Enter, and splitting a list item or a
    // cell is not what this rule does.
    it('fires only in a paragraph of its own, not in a list item or a table cell', () => {
      const list = build('- item')
      list.commands.setTextSelection(endOf(list) - 1)
      enter(list, true)
      typeAt(list, '- x')
      expect(shape(list)[0]).toBe('bulletList:item[br]- x')

      const table = build('| a | b |\n| --- | --- |\n| 1 | 2 |')
      table.commands.setTextSelection(5)
      enter(table, true)
      typeAt(table, '# x')
      expect(shape(table)[0]).toBe('table:a[br]# x|b|1|2')
    })

    // One Backspace, as for the stock rules and the highlight rule: someone
    // who meant the marker literally gets it back, break and all, and it is
    // still literal when the note is opened again. Not the last block: at the
    // end of a note StarterKit appends a paragraph straight after any rule,
    // and that transaction clears what Backspace would undo — for the stock
    // rules exactly as for these.
    it.each(MARKERS)('gives back the break and a literal %j on one Backspace', (marker) => {
      const editor = afterBreak(marker, '\n\nlast')
      expect(shape(editor)[0]).toBe('paragraph:first')

      backspace(editor)

      expect(shape(editor)).toEqual([`paragraph:first[br]${marker}zz`, 'paragraph:last'])
      expect(reopened(editor)).toEqual([`paragraph:first[br]${marker}zz`, 'paragraph:last'])
    })
  })
})
