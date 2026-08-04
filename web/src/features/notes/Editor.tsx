import { useEffect, useRef } from 'react'
import { EditorView, minimalSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'

type Props = {
  noteId: string
  initialBody: string
  label: string
  onChange: (bodyMd: string) => void
}

export default function Editor({ noteId, initialBody, label, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null)
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
    const view = new EditorView({
      doc: latest.current.initialBody,
      parent: host.current!,
      extensions: [
        // minimalSetup, not basicSetup: no line numbers, no fold gutter.
        minimalSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': latest.current.label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            latest.current.onChange(update.state.doc.toString())
          }
        }),
      ],
    })
    return () => view.destroy()
  }, [noteId])

  return <div className="editor" ref={host} />
}
