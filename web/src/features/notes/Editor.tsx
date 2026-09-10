import { useEffect, useRef } from 'react'
import { EditorView, minimalSetup } from 'codemirror'
import { Annotation } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { highlightActiveLine } from '@codemirror/view'
import { observeNote } from '../../db/notes.ts'
import { mathExtension } from './mathExtension.ts'

// Marks a transaction as carrying a body that arrived from sync. Without it
// the update listener below reports the server's own text back as something
// the user typed, which saves it as a local edit and forks the note against
// the server on the next push.
const fromSync = Annotation.define<boolean>()

// CodeMirror paints the caret, the selection and the active line itself, in
// its own colours, and none of it inherits from index.css — styling it from
// there means outspecifying a theme that reattaches on every reconfigure.
// The values are read back out of the palette so it stays the one source.
const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--text)' },
  // A 1px hairline in the default grey was the cursor that could not be found.
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--text)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--selection)' },
  '.cm-activeLine': { backgroundColor: 'var(--raised)' },
})

type Props = {
  noteId: string
  initialBody: string
  label: string
  onChange: (bodyMd: string) => void
}

export default function Editor({ noteId, initialBody, label, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ initialBody, label, onChange })

  // Declared before the view effect so that on mount it runs first, and on a
  // note switch it has the new note's body ready for the rebuilt view.
  useEffect(() => {
    latest.current = { initialBody, label, onChange }
  })

  useEffect(() => {
    // CodeMirror owns the document from here on. Nothing re-renders it as a
    // controlled value: that fights the editor and loses the cursor. Switching
    // notes destroys and rebuilds instead of dispatching a document swap.
    const created = new EditorView({
      doc: latest.current.initialBody,
      parent: host.current!,
      extensions: [
        // minimalSetup, not basicSetup: no line numbers, no fold gutter.
        minimalSetup,
        markdown(),
        mathExtension,
        theme,
        highlightActiveLine(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': latest.current.label }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (update.transactions.some((tr) => tr.annotation(fromSync))) return
          latest.current.onChange(update.state.doc.toString())
        }),
      ],
    })
    view.current = created
    return () => {
      created.destroy()
      view.current = null
    }
  }, [noteId])

  // A pull writes a new body into the row while CodeMirror still holds the
  // old one in its own document, and the next keystroke would push the stale
  // text back. Watching the row is what closes that gap.
  useEffect(() => {
    const subscription = observeNote(noteId).subscribe((note) => {
      const current = view.current
      if (current === null || note === undefined) return
      // The same rule pull.ts applies to the row, one layer up. A dirty note
      // holds edits the server has not seen; the next push either lands them
      // or forks them, and that path already works. Overwriting here is the
      // one way this can lose typing.
      if (note.dirty) return
      // Nothing to do when the row already says what the document says. The
      // subscription also fires on this editor's own autosave writes, and on
      // a push clearing the dirty flag.
      if (note.bodyMd === current.state.doc.toString()) return
      const head = current.state.selection.main.head
      // A transaction, never a new EditorView: rebuilding would throw away
      // the undo history and the selection.
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: note.bodyMd },
        // Clamped, because the remote body can be shorter than the offset the
        // cursor sat at. A cursor jumping to the start mid-read is avoidable.
        selection: { anchor: Math.min(head, note.bodyMd.length) },
        annotations: fromSync.of(true),
      })
    })
    return () => subscription.unsubscribe()
  }, [noteId])

  return <div className="editor" ref={host} />
}
