import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Editor as TipTap, InputRule } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
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
import BubbleMenu from './BubbleMenu.tsx'
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
    // openOnClick stays false because the extension's own handler opens on
    // every plain click with no modifier check, which would navigate away
    // mid-sentence and leave no way to put a caret in a link to fix its URL.
    // The modifier-aware version is handleClick below.
    StarterKit.configure({
      link: {
        openOnClick: false,
        // The extension's default rel is 'noopener noreferrer nofollow'.
        // nofollow withholds ranking credit from a page you link to, which is
        // a publisher's concern; these notes are private and are not a page.
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      },
    }),
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
      // The extension leaves katexOptions undefined, so KaTeX ran with its
      // default displayMode: false and emitted an inline .katex — and
      // .katex-display, the class that centres display maths and gives it its
      // own line, was never in the document at all. The wrapper was a `div`
      // the whole time; the containing block was never the problem.
      katexOptions: { displayMode: true },
      onClick: (node, pos) => openMath?.(pos, node.attrs.latex, true),
      onOpen: (pos: number) => openMath?.(pos, '', true),
    }),
  ]
}

type Menu = {
  // Carried rather than read off the ref at render time: the menu only ever
  // exists because an editor event created it, so the instance is in hand at
  // the point the position is measured.
  editor: TipTap
  top: number
  left: number
  below: boolean
  link: boolean
}

// Roughly what the menu stands, and the only thing the number decides is
// whether a selection near the top of the pane gets its menu above or below.
// Measuring the real element would mean rendering it somewhere to be measured
// and then moving it, for an answer this close.
const MENU_HEIGHT = 52

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
  const menuEl = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  // Mirrored into a ref because editorProps are captured when the editor is
  // built, so the key handlers hung there would otherwise read the menu as it
  // was on mount and never see it open.
  const menuNow = useRef<Menu | null>(null)
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

  const place = useCallback((next: Menu | null) => {
    menuNow.current = next
    setMenu(next)
  }, [])

  // Driven by the selection rather than by a mouse event, because a finger
  // selecting text fires no mouseup the way a mouse does, and iPad is a
  // target. Everything that moves the selection — dragging, shift-arrow, a
  // command — opens the menu the same way.
  const refresh = useCallback(() => {
    const current = view.current
    const box = scroll.current
    if (current === null || box === null) return
    const { selection } = current.state
    // A NodeSelection is not empty either, and clicking a formula makes one.
    // Asking only whether the selection is empty puts this menu on top of the
    // formula source field and takes the focus that field needs.
    if (!(selection instanceof TextSelection) || selection.empty) {
      place(null)
      return
    }
    const at = current.view.coordsAtPos(selection.from)
    const bounds = box.getBoundingClientRect()
    // Above the selection, so it does not cover the words being formatted,
    // unless there is no room above to be had.
    const below = at.top - bounds.top < MENU_HEIGHT
    const edge = below ? current.view.coordsAtPos(selection.to).bottom : at.top
    // Offsets inside the scroll container, like the formula field, so the
    // menu travels with the text rather than hanging in the viewport.
    place({
      editor: current,
      top: edge - bounds.top + box.scrollTop,
      left: at.left - bounds.left + box.scrollLeft,
      below,
      link: false,
    })
  }, [place])

  const setLinkOpen = useCallback(
    (open: boolean) => {
      const current = menuNow.current
      if (current !== null) place({ ...current, link: open })
    },
    [place],
  )

  useEffect(() => {
    // TipTap owns the document from here on. Nothing re-renders it as a
    // controlled value: that fights the editor and loses the cursor.
    // Switching notes destroys and rebuilds instead of swapping content.
    const created = new TipTap({
      element: host.current!,
      extensions: editorExtensions(openMath),
      content: latest.current.initialBody,
      contentType: 'markdown',
      editorProps: {
        attributes: { 'aria-label': latest.current.label },
        // Cmd on Apple hardware, Ctrl elsewhere — the chord that opens a link
        // in a new tab everywhere else. Without a modifier this returns false
        // and the click falls through to ProseMirror, which places the cursor:
        // that is what makes a wrong URL fixable, because the bubble menu's
        // link input reads the link the cursor is sitting in.
        handleClick: (_view, _pos, event) => {
          if (!event.metaKey && !event.ctrlKey) return false
          const target = event.target
          const href =
            target instanceof Element
              ? target.closest('a')?.getAttribute('href')
              : undefined
          if (!href) return false
          event.preventDefault()
          // noopener,noreferrer in the features string as well as in rel: rel
          // governs a navigation the document starts, and this is a window
          // opened by script, which rel does not reach.
          window.open(href, '_blank', 'noopener,noreferrer')
          return true
        },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Escape' && menuNow.current !== null) {
            // stopPropagation as well: App's Escape handler is on the window
            // and never asks whether anyone has dealt with the key already,
            // so without this the note closes behind the menu. The selection
            // is left exactly as it was.
            event.preventDefault()
            event.stopPropagation()
            place(null)
            return true
          }
          // The universal binding, and the only one here that StarterKit does
          // not already ship. It means nothing without something to link, so
          // a collapsed selection leaves the key to the browser.
          if (
            event.key === 'k' &&
            (event.metaKey || event.ctrlKey) &&
            menuNow.current !== null
          ) {
            event.preventDefault()
            setLinkOpen(true)
            return true
          }
          return false
        },
      },
      onSelectionUpdate: refresh,
      onUpdate: ({ editor }) => {
        unsaved.current = true
        latest.current.onChange(editor.getMarkdown())
        // Toggling a mark moves nothing, so selectionUpdate does not fire and
        // the buttons would go on showing the state from before the click.
        refresh()
      },
      onBlur: ({ event }) => {
        const next = event.relatedTarget
        // Focus landing inside the menu is the link input opening, not the
        // user leaving. Anything else closes it — including the formula
        // source field, which is how the two stay out of each other's way.
        if (next instanceof Node && menuEl.current?.contains(next)) return
        place(null)
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
      place(null)
    }
  }, [noteId, openMath, place, refresh, setLinkOpen])

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

  // The selected words become the formula's source, so a line of maths that
  // was typed as prose can be turned into maths without retyping it.
  const wrapMath = () => {
    const current = view.current
    if (current === null) return
    const { from, to } = current.state.selection
    const latex = current.state.doc.textBetween(from, to)
    current
      .chain()
      .insertContentAt({ from, to }, { type: 'inlineMath', attrs: { latex } })
      .run()
    place(null)
    // The node sits at `from` now. Opening the source field over it is what
    // makes it correctable: prose rarely comes out as valid LaTeX first time.
    openMath(from, latex, false)
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
      {menu !== null && (
        <BubbleMenu
          ref={menuEl}
          editor={menu.editor}
          top={menu.top}
          left={menu.left}
          below={menu.below}
          link={menu.link}
          onLink={setLinkOpen}
          onMath={wrapMath}
        />
      )}
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
