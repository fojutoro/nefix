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
import { useTranslation } from 'react-i18next'
import { observeNote } from '../../db/notes.ts'
import BubbleMenu from './BubbleMenu.tsx'
import BlockMenu from './BlockMenu.tsx'
import { KEEP, filterBlocks, type Labelled, type Translate } from './blocks.ts'
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

// A `/` is a command only when it opens a word: at the start of a block, or
// after a space. This is read off the text in front of the cursor rather than
// from a keydown, because `http://x`, `24/7` and `and/or` all press the same
// key and only the character before the slash tells them apart.
const SLASH = /(?:^|\s)\/(\S*)$/

// The gutter is --margin wide and the button fills it. The menu drops below
// the button rather than beside it: beside it is on top of the block being
// added to.
const BUTTON = 44

// Where the + button sits, and the start of the block it belongs to. The
// position is what the button hands back — clicking it puts the cursor in that
// block before inserting under it, so the pointer path and the cursor path end
// in the same place.
type Anchor = { top: number; pos: number }

type Blocks = {
  top: number
  left: number
  filter: string
  // Position of the `/` that opened this, or null when the + button did. It is
  // both the range a command deletes and the marker Escape remembers, so a
  // dismissed menu does not spring back open on the next keystroke.
  slash: number | null
  picked: number
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
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [blocks, setBlocks] = useState<Blocks | null>(null)
  const blockEl = useRef<HTMLDivElement>(null)
  // Mirrored for the same reason menuNow is: the handlers below are captured
  // when the editor is built and would otherwise read the state as it was on
  // mount.
  const blocksNow = useRef<Blocks | null>(null)
  const editingNow = useRef<Editing | null>(null)
  const translate = useRef<Translate>(() => '')
  // The slash Escape dismissed. Without it the detection matches the very same
  // text on the next keystroke and the menu comes straight back, which is the
  // whole of what Escape is for here.
  const dismissed = useRef<number | null>(null)
  // Whether the document holds a change the store has not taken yet. `dirty`
  // cannot answer that: it means IndexedDB differs from the server, not that
  // the document differs from IndexedDB. Between a keystroke and autosave
  // firing 500ms later, a note that was just pushed is clean and its row is
  // stale, and that is the window a pull used to overwrite. See #37.
  const unsaved = useRef(false)
  const latest = useRef({ initialBody, label, focus, onChange })
  const { t } = useTranslation()
  // Wrapped rather than passed straight through: filterBlocks wants one narrow
  // signature and TFunction is a pile of overloads.
  const say: Translate = (key, args) => t(key, args)
  useEffect(() => {
    translate.current = say
  })

  // Declared before the editor effect so that on mount it runs first, and on a
  // note switch it has the new note's body ready for the rebuilt editor.
  useEffect(() => {
    latest.current = { initialBody, label, focus, onChange }
  })

  const edit = useCallback((next: Editing | null) => {
    editingNow.current = next
    setEditing(next)
  }, [])

  const show = useCallback((next: Blocks | null) => {
    blocksNow.current = next
    setBlocks(next)
  }, [])

  // Stable, because it is baked into the extensions when the editor is built.
  const openMath = useCallback((pos: number, latex: string, block: boolean) => {
    const current = view.current
    const box = scroll.current
    if (current === null || box === null) return
    const at = current.view.coordsAtPos(pos)
    const bounds = box.getBoundingClientRect()
    // Offsets inside the scroll container rather than viewport coordinates, so
    // the field travels with the formula when the note is scrolled.
    edit({
      pos,
      latex,
      block,
      top: at.bottom - bounds.top + box.scrollTop,
      left: at.left - bounds.left + box.scrollLeft,
    })
  }, [edit])

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

  // Guarded on `top` alone, because that is the only thing the anchor decides
  // visually and this runs on every keystroke. A cursor moving within one
  // block gives the same block start, so writing a fresh object each time
  // would re-render the pane for nothing.
  const anchorAt = useCallback(
    (current: TipTap, box: HTMLDivElement, pos: number) => {
      const $pos = current.state.doc.resolve(pos)
      const start = $pos.depth === 0 ? pos : $pos.start(1)
      let at
      try {
        at = current.view.coordsAtPos(start)
      } catch {
        // coordsAtPos throws for a position the view has not drawn yet, and
        // this runs once on mount, before there is any layout to measure. The
        // button is a convenience; an uncaught throw here is the whole editor,
        // so the previous anchor stands and the next selection change retries.
        return
      }
      const bounds = box.getBoundingClientRect()
      const top = at.top - bounds.top + box.scrollTop
      setAnchor((prev) =>
        prev !== null && prev.top === top && prev.pos === start
          ? prev
          : { top, pos: start },
      )
    },
    [],
  )

  // Runs on every selection change and every document change, because both can
  // move the cursor into or out of a `/` that is already typed.
  const track = useCallback(() => {
    const current = view.current
    const box = scroll.current
    if (current === null || box === null) return
    const { selection } = current.state
    anchorAt(current, box, selection.from)

    // The + button's menu is not driven by the text and must not be closed by
    // it: opening it moves the selection, which lands right back here.
    const open = blocksNow.current
    if (open !== null && open.slash === null) return

    // A selection that is not empty belongs to the bubble menu, and the
    // formula source field holds the cursor this menu would cover. Neither is
    // a moment at which a second surface may open.
    if (
      !(selection instanceof TextSelection) ||
      !selection.empty ||
      editingNow.current !== null ||
      !selection.$from.parent.isTextblock
    ) {
      show(null)
      return
    }
    const { $from } = selection
    const before = $from.parent.textBetween(0, $from.parentOffset, '\n', ' ')
    const match = SLASH.exec(before)
    if (match === null) {
      // Out of the slash altogether, so whatever Escape dismissed is history.
      dismissed.current = null
      show(null)
      return
    }
    const filter = match[1]!
    const slash = selection.from - filter.length - 1
    if (dismissed.current === slash) return
    // Typing a sentence that begins with a slash must not trap anyone in a
    // menu, so a filter that matches nothing closes it.
    if (filterBlocks(filter, translate.current).length === 0) {
      show(null)
      return
    }
    const at = current.view.coordsAtPos(slash)
    const bounds = box.getBoundingClientRect()
    show({
      top: at.bottom - bounds.top + box.scrollTop,
      left: at.left - bounds.left + box.scrollLeft,
      filter,
      slash,
      // Back to the top whenever the list changes underneath, or Enter runs
      // whatever happens to be sitting at a stale index.
      picked: open !== null && open.filter === filter ? open.picked : 0,
    })
  }, [anchorAt, show])

  const runBlock = useCallback(
    (item: Labelled) => {
      const current = view.current
      const open = blocksNow.current
      if (current === null || open === null) return
      show(null)
      dismissed.current = null
      if (open.slash === null) {
        // Below the block rather than at the cursor: that is what a + in a
        // margin means everywhere else, and inserting mid-paragraph would
        // split text in a way nobody intends. What the command then runs on is
        // an empty paragraph — exactly the state the slash path leaves behind,
        // which is what makes the two triggers the same action and not two
        // implementations that agree by luck.
        const { $from } = current.state.selection
        const at = $from.depth === 0 ? $from.pos : $from.after(1)
        current
          .chain()
          .focus(null, KEEP)
          .insertContentAt(at, { type: 'paragraph' })
          .setTextSelection(at + 1)
          .run()
      } else {
        current
          .chain()
          .focus(null, KEEP)
          .deleteRange({ from: open.slash, to: current.state.selection.from })
          .run()
      }
      item.command.run(current, (pos) => openMath(pos, '', true))
    },
    [openMath, show],
  )

  const moveBlock = useCallback(
    (delta: number) => {
      const open = blocksNow.current
      if (open === null) return
      const found = filterBlocks(open.filter, translate.current)
      if (found.length === 0) return
      show({
        ...open,
        picked: (open.picked + delta + found.length) % found.length,
      })
    },
    [show],
  )

  // refocus is false when the menu is closing because the focus already went
  // somewhere else, and taking it back would pull the user off whatever they
  // just clicked.
  const closeBlock = useCallback(
    (refocus: boolean) => {
      const open = blocksNow.current
      if (open === null) return
      // The `/` stays where it was typed: it is text that happened to open a
      // menu, and closing the menu does not make it not text.
      dismissed.current = open.slash
      show(null)
      if (refocus) view.current?.commands.focus(null, KEEP)
    },
    [show],
  )

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
          // The slash menu leaves the focus in the document, so its keys
          // arrive here. The + button's menu takes focus and handles its own.
          const block = blocksNow.current
          if (block !== null && block.slash !== null) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              moveBlock(event.key === 'ArrowDown' ? 1 : -1)
              return true
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const item = filterBlocks(block.filter, translate.current)[
                block.picked
              ]
              if (item !== undefined) runBlock(item)
              return true
            }
            if (event.key === 'Escape') {
              // stopPropagation for the same reason the bubble menu does it:
              // App's window handler would close the note behind the menu.
              event.preventDefault()
              event.stopPropagation()
              closeBlock(true)
              return true
            }
          }
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
      onSelectionUpdate: () => {
        refresh()
        track()
      },
      onUpdate: ({ editor }) => {
        unsaved.current = true
        latest.current.onChange(editor.getMarkdown())
        // Toggling a mark moves nothing, so selectionUpdate does not fire and
        // the buttons would go on showing the state from before the click.
        refresh()
        track()
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
    // Once on mount, because nothing has moved the selection yet and the +
    // button would otherwise not appear until the first keystroke — on a note
    // opened and not yet typed in, which is exactly when someone is looking
    // for a way to add a block.
    track()
    return () => {
      created.destroy()
      view.current = null
      edit(null)
      show(null)
      place(null)
    }
  }, [
    closeBlock,
    edit,
    moveBlock,
    noteId,
    openMath,
    place,
    refresh,
    runBlock,
    setLinkOpen,
    show,
    track,
  ])

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
    edit(null)
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

  const openFromButton = () => {
    const current = view.current
    if (current === null || anchor === null) return
    // The cursor goes into the anchored block first, so the pointer path
    // inserts under the block the + is beside rather than under wherever the
    // cursor happened to be left.
    current.commands.setTextSelection(anchor.pos)
    show({ top: anchor.top + BUTTON, left: 0, filter: '', slash: null, picked: 0 })
  }

  const cancel = () => {
    // Escape restores what was there, except that a formula opened empty by
    // `$$ ` has nothing to restore and should not survive being abandoned.
    if (editing !== null && editing.latex === '') commit('')
    else close()
  }

  return (
    <div
      className="editor"
      ref={scroll}
      onMouseMove={(event) => {
        const current = view.current
        const box = scroll.current
        // Not while a menu is open: the anchor would crawl after the pointer
        // on its way to the menu and move the button out from under it.
        if (current === null || box === null || blocksNow.current !== null) return
        const found = current.view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })
        if (found !== null) anchorAt(current, box, found.pos)
      }}
    >
      <div ref={host} />
      {anchor !== null && (
        <button
          type="button"
          className="block-add"
          aria-label={t('editor.insertBlock')}
          style={{ top: `${anchor.top}px` } as CSSProperties}
          // Refusing mousedown keeps the selection in the document, which is
          // what every command in the menu acts on.
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={openFromButton}
        >
          +
        </button>
      )}
      {blocks !== null && (
        <BlockMenu
          ref={blockEl}
          items={filterBlocks(blocks.filter, say)}
          picked={blocks.picked}
          top={blocks.top}
          left={blocks.left}
          focus={blocks.slash === null}
          onPick={(index) => show({ ...blocks, picked: index })}
          onRun={runBlock}
          onMove={moveBlock}
          onClose={closeBlock}
        />
      )}
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
