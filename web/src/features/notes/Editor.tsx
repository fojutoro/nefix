import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Editor as TipTap, InputRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import {
  BlockMath,
  InlineMath,
  type BlockMathOptions,
} from '@tiptap/extension-mathematics'
import { TableKit } from '@tiptap/extension-table'
import { TaskList } from '@tiptap/extension-list/task-list'
import { TaskItem } from '@tiptap/extension-list/task-item'
import Image from '@tiptap/extension-image'
import { observeNote } from '../../db/notes.ts'
import { findMath } from './math.ts'

// `@tiptap/extension-mathematics` tokenises inline maths with
// /^\$([^$]+)\$(?!\$)/, which has no delimiter rule at all: "It costs $5 and
// $10 today." matches, and a sentence about money becomes a formula with its
// space eaten. findMath already implements the rule that keeps prose out of
// the maths — see the comment above formulaAt in math.ts — so both the
// markdown tokeniser and the input rule below are wired to it rather than
// carrying a second, weaker copy of the same idea.
//
// Registration is process-wide and first-one-wins: whichever `inlineMath`
// tokeniser reaches marked first is the one that runs, for every editor built
// afterwards. Nothing may load the stock InlineMath, here or in a test, or
// this correction is silently discarded.
const inlineMathTokenizer = {
  name: 'inlineMath',
  level: 'inline' as const,
  start: (src: string) => src.indexOf('$'),
  tokenize: (src: string) => {
    // One line, because an unclosed `$` is prose rather than a formula that
    // swallows the rest of the note, and because scanning the whole remaining
    // source on every `$` is quadratic on a long note.
    const line = src.split('\n', 1)[0] ?? ''
    const formula = findMath(line).find(
      (range) => range.from === 0 && range.kind === 'inline',
    )
    if (formula === undefined) return undefined
    return {
      type: 'inlineMath',
      raw: line.slice(0, formula.to),
      latex: formula.content,
    }
  },
}

// The same rule again, at the keyboard: the formula closes when a `$` lands at
// the cursor and the text between the delimiters obeys findMath. The stock
// rule fires on `$$…$$` instead, so typing the `$x^2$` that is already in
// every note produced nothing at all.
const inlineMathInput = (text: string) => {
  const formula = findMath(text).find(
    (range) => range.to === text.length && range.kind === 'inline',
  )
  if (formula === undefined) return null
  return { index: formula.from, text: text.slice(formula.from) }
}

const InlineMathSource = InlineMath.extend({
  markdownTokenizer: inlineMathTokenizer,
  addInputRules() {
    return [
      new InputRule({
        find: inlineMathInput,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex: match[0]!.slice(1, -1) }),
          )
        },
      }),
    ]
  },
})

// The stock block rule is /^\$\$\$([^$]+)\$\$\$$/ — triple dollars, and the
// whole formula typed in one go, so display maths could not be built up a
// character at a time. `$$ ` opens an empty one instead and hands its position
// back, because an empty block maths node renders as an empty box with no way
// to fill it; the source field is what makes it reachable.
type BlockMathSourceOptions = BlockMathOptions & {
  // Called with the position of a block opened empty by `$$ `, so the source
  // field can be put over it at once.
  onOpen?: (pos: number) => void
}

const BlockMathSource = BlockMath.extend<BlockMathSourceOptions>({
  addOptions() {
    return { ...this.parent?.(), onOpen: undefined }
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$ $/,
        handler: ({ state, range }) => {
          const { tr } = state
          const $from = state.doc.resolve(range.from)
          const replaceable = $from
            .node(-1)
            .canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)
          if (!replaceable) return null
          const at = $from.before()
          tr.replaceWith(at, $from.after(), this.type.create({ latex: '' }))
          // After the transaction lands, or there is no node under the
          // position yet and nothing to measure for placing the field.
          const open = this.options.onOpen
          if (open) setTimeout(() => open(at), 0)
        },
      }),
    ]
  },
})

export type OpenMath = (pos: number, latex: string, block: boolean) => void

// Exported so the round-trip fixture builds its editor the same way this one
// does. A construct the app supports but the extension list does not is not an
// error anywhere — it is simply gone from the note, so the fixture has to
// reach the real list rather than a copy that can drift away from it.
// eslint-disable-next-line react-refresh/only-export-components
export function editorExtensions(openMath?: OpenMath) {
  return [
    // Link rides along for round-trip fidelity only. Opening one on click
    // would navigate away mid-sentence, and link editing is a later PR.
    StarterKit.configure({ link: { openOnClick: false } }),
    Markdown,
    // Present so `![alt](url)` keeps its URL. There is no upload, no paste
    // handling and no UI: not eating an existing construct is not the same as
    // implementing images.
    Image,
    TableKit,
    TaskList,
    TaskItem,
    InlineMathSource.configure({
      onClick: (node, pos) => openMath?.(pos, node.attrs.latex, false),
    }),
    BlockMathSource.configure({
      onClick: (node, pos) => openMath?.(pos, node.attrs.latex, true),
      onOpen: (pos: number) => openMath?.(pos, '', true),
    }),
  ]
}

type Editing = {
  pos: number
  latex: string
  block: boolean
  top: number
  left: number
}

type Props = {
  noteId: string
  initialBody: string
  label: string
  mathLabel: string
  // Set for a note that was just created, so `n` lands the cursor in it.
  // Taking focus on every note switch would pull it off the row that was
  // clicked, which is not the same thing at all.
  focus: boolean
  onChange: (bodyMd: string) => void
}

export default function Editor({
  noteId,
  initialBody,
  label,
  mathLabel,
  focus,
  onChange,
}: Props) {
  const scroll = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<TipTap | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  // Whether the document holds a change the store has not taken yet. `dirty`
  // cannot answer that: it means IndexedDB differs from the server, not that
  // the document differs from IndexedDB. Between a keystroke and autosave
  // firing 500ms later, a note that was just pushed is clean and its row is
  // stale, and that is the window a pull used to overwrite. See #37.
  const unsaved = useRef(false)
  const latest = useRef({ initialBody, label, focus, onChange })

  // Declared before the editor effect so that on mount it runs first, and on a
  // note switch it has the new note's body ready for the rebuilt editor.
  useEffect(() => {
    latest.current = { initialBody, label, focus, onChange }
  })

  // Stable, because it is baked into the extensions when the editor is built.
  const openMath = useCallback((pos: number, latex: string, block: boolean) => {
    const current = view.current
    const box = scroll.current
    if (current === null || box === null) return
    const at = current.view.coordsAtPos(pos)
    const bounds = box.getBoundingClientRect()
    // Offsets inside the scroll container rather than viewport coordinates, so
    // the field travels with the formula when the note is scrolled.
    setEditing({
      pos,
      latex,
      block,
      top: at.bottom - bounds.top + box.scrollTop,
      left: at.left - bounds.left + box.scrollLeft,
    })
  }, [])

  useEffect(() => {
    // TipTap owns the document from here on. Nothing re-renders it as a
    // controlled value: that fights the editor and loses the cursor.
    // Switching notes destroys and rebuilds instead of swapping content.
    const created = new TipTap({
      element: host.current!,
      extensions: editorExtensions(openMath),
      content: latest.current.initialBody,
      contentType: 'markdown',
      editorProps: { attributes: { 'aria-label': latest.current.label } },
      onUpdate: ({ editor }) => {
        unsaved.current = true
        latest.current.onChange(editor.getMarkdown())
      },
    })
    view.current = created
    // scrollIntoView: false because the cursor lands at the top of a note
    // that was just created, so there is nothing to scroll to, and asking
    // costs a layout measurement the editor has not been laid out for yet.
    if (latest.current.focus) {
      created.commands.focus(null, { scrollIntoView: false })
    }
    return () => {
      created.destroy()
      view.current = null
      setEditing(null)
    }
  }, [noteId, openMath])

  // A pull writes a new body into the row while TipTap still holds the old one
  // in its own document, and the next keystroke would push the stale text
  // back. Watching the row is what closes that gap.
  useEffect(() => {
    const subscription = observeNote(noteId).subscribe((note) => {
      const current = view.current
      if (current === null || note === undefined) return
      // Nothing to do when the row already says what the document says, and
      // it is also the only proof that the store has caught up: this fires on
      // the editor's own autosave writes and on a push clearing the flag.
      // Checked before dirty, because our own write arrives dirty and still
      // means the document is safe.
      if (note.bodyMd === current.getMarkdown()) {
        unsaved.current = false
        return
      }
      // Keystrokes autosave has not written yet. They are not dirty anywhere
      // because nothing has been written for them to be dirty about, so this
      // is the only guard standing between them and a pull. The pending write
      // wins: it lands a moment later and forks against the server the way
      // any other conflict does.
      if (unsaved.current) return
      // The same rule pull.ts applies to the row, one layer up. A dirty note
      // holds edits the server has not seen; the next push either lands them
      // or forks them, and that path already works. Overwriting here is the
      // one way this can lose typing.
      if (note.dirty) return
      const head = current.state.selection.from
      // emitUpdate: false is the whole of the echo-back guard. Without it the
      // update handler reports the server's own text back as something the
      // user typed, which saves it as a local edit and forks the note against
      // the server on the next push.
      current.commands.setContent(note.bodyMd, {
        contentType: 'markdown',
        emitUpdate: false,
      })
      // Clamped, because the remote body can be shorter than the offset the
      // cursor sat at. A cursor jumping to the start mid-read is avoidable.
      const end = Math.max(0, current.state.doc.content.size - 1)
      current.commands.setTextSelection(Math.min(head, end))
    })
    return () => subscription.unsubscribe()
  }, [noteId])

  const close = () => {
    setEditing(null)
    view.current?.commands.focus()
  }

  const commit = (value: string) => {
    const current = view.current
    if (current === null || editing === null) return
    const latex = value.trim()
    const chain = current.chain()
    if (latex === '') {
      // A formula with nothing in it is not a formula, and leaving one behind
      // writes `$$\n$$` into the note.
      if (editing.block) chain.deleteBlockMath({ pos: editing.pos })
      else chain.deleteInlineMath({ pos: editing.pos })
    } else if (editing.block) {
      chain.updateBlockMath({ latex, pos: editing.pos })
    } else {
      chain.updateInlineMath({ latex, pos: editing.pos })
    }
    chain.run()
    close()
  }

  const cancel = () => {
    // Escape restores what was there, except that a formula opened empty by
    // `$$ ` has nothing to restore and should not survive being abandoned.
    if (editing !== null && editing.latex === '') commit('')
    else close()
  }

  return (
    <div className="editor" ref={scroll}>
      <div ref={host} />
      {editing !== null && (
        <input
          // Keyed by position so moving to another formula remounts the field
          // rather than carrying the previous formula's text into it.
          key={editing.pos}
          className="math-source"
          aria-label={mathLabel}
          autoFocus
          defaultValue={editing.latex}
          spellCheck={false}
          style={
            { top: `${editing.top}px`, left: `${editing.left}px` } as CSSProperties
          }
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Held here, or Escape closes the note and `n` creates one.
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              commit(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
        />
      )}
    </div>
  )
}
