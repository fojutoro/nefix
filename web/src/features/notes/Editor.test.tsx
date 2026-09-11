import 'fake-indexeddb/auto'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Editor as TipTap } from '@tiptap/core'
import { Editor as BareEditor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n/index.ts'
import { db, type Note } from '../../db/schema.ts'
import { updateNote } from '../../db/notes.ts'
import CSS from '../../index.css?raw'
import Editor, { editorExtensions, type OpenMath } from './Editor.tsx'
import { outline } from './outline.ts'
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

  it('paints no ruling in the editor, and keeps it on the class page', () => {
    const tiptap = paint('<p>a</p>')
    expect(getComputedStyle(tiptap.parentElement!).backgroundImage).not.toContain(
      'gradient',
    )

    // The same ruling on the surface it was always right for, so this says
    // "moved" rather than "deleted".
    const page = document.createElement('div')
    page.className = 'page'
    document.body.appendChild(page)
    mounted.push(page)
    expect(getComputedStyle(page).backgroundImage).toContain('gradient')
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

    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    await press(blockMenu(container) as HTMLElement, 'n')
    await press(blockMenu(container) as HTMLElement, 'Escape')
    window.removeEventListener('keydown', seen)

    expect(seen).not.toHaveBeenCalled()
    expect(blockMenu(container)).toBeNull()
  })
})
