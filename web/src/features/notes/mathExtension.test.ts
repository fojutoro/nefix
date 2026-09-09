import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { mathExtension } from './mathExtension.ts'

// CodeMirror measures itself once it mounts, and jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver ??= NoopResizeObserver

let view: EditorView | null = null

const open = (doc: string) => {
  view = new EditorView({ doc, parent: document.body, extensions: [mathExtension] })
  return view
}

// The source each replacing decoration covers. Read off the plugin rather than
// the DOM, so a case says which range was replaced and not merely that
// something rendered.
const replaced = (editor: EditorView) => {
  const sources: string[] = []
  editor
    .plugin(mathExtension)!
    .decorations.between(0, editor.state.doc.length, (from, to) => {
      sources.push(editor.state.sliceDoc(from, to))
    })
  return sources
}

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('mathExtension', () => {
  it('replaces a formula the cursor is outside of with a rendered widget', () => {
    const editor = open('the sum $x^2$ of it')

    expect(replaced(editor)).toEqual(['$x^2$'])
    expect(document.querySelector('.katex')).not.toBeNull()
  })

  it('shows the source again while the cursor is inside the formula', () => {
    const editor = open('the sum $x^2$ of it')

    editor.dispatch({ selection: { anchor: 10 } })
    expect(replaced(editor)).toEqual([])

    editor.dispatch({ selection: { anchor: 0 } })
    expect(replaced(editor)).toEqual(['$x^2$'])
  })

  it('rebuilds when the document changes under it, as a sync writes it', () => {
    const editor = open('nothing yet')

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: 'the sum $x^2$' },
    })

    expect(replaced(editor)).toEqual(['$x^2$'])
  })

  it('renders display math in display mode', () => {
    const editor = open('before\n$$\\frac{a}{b}$$')

    expect(replaced(editor)).toEqual(['$$\\frac{a}{b}$$'])
    expect(document.querySelector('.katex-display')).not.toBeNull()
  })

  it('does not throw on half-typed LaTeX', () => {
    const editor = open('half $\\frac{$ typed')

    expect(replaced(editor)).toEqual(['$\\frac{$'])
    expect(document.querySelector('.katex-error')).not.toBeNull()
  })
})
