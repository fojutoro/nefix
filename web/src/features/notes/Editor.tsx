import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  Editor as TipTap,
  Extension,
  InputRule,
  Mark,
  PasteRule,
  flattenExtensions,
  type ChainedCommands,
  getExtensionField,
  type Node as TipTapNode,
} from '@tiptap/core'
import type { MarkType, Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model'
import {
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import {
  BlockMath,
  InlineMath,
  type BlockMathOptions,
} from '@tiptap/extension-mathematics'
import { Table, TableKit } from '@tiptap/extension-table'
import { TaskList } from '@tiptap/extension-list/task-list'
import { TaskItem } from '@tiptap/extension-list/task-item'
import Image from '@tiptap/extension-image'
import { useTranslation } from 'react-i18next'
import { observeDeadlines } from '../../db/deadlines.ts'
import { observeNote } from '../../db/notes.ts'
import BubbleMenu from './BubbleMenu.tsx'
import BlockMenu from './BlockMenu.tsx'
import BlockControls from './BlockControls.tsx'
import { KEEP, filterBlocks, type Labelled, type Translate } from './blocks.ts'
import { findMath } from './math.ts'
import {
  TopicHighlight,
  headingAt,
  markTopics,
  namedIn,
  sameNames,
} from './topics.ts'

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

// `==text==`, the highlight most markdown editors read. Marked has no
// tokeniser for it, so this carries one. Backslash escapes are taken as units
// while looking for the closing `==`, or a `\==` saved inside a highlight would
// close it early.
const HIGHLIGHT = /^==(?=\S)((?:\\.|[^\\\n])+?)==(?!=)/

// Typed or pasted, `==text==` becomes the mark only where the tokeniser above
// would read it back as one: the text neither starts nor ends with a space.
// Bold's own pattern allows the spaces, and a highlight made under it saves as
// `== a ==` and reopens as literal text.
const HIGHLIGHT_TYPED = /(?:^|\s)(==([^=\s](?:[^=]*[^=\s])?)==)$/
const HIGHLIGHT_PASTED = /(?:^|\s)(==([^=\s](?:[^=]*[^=\s])?)==)/g

// The one place a highlight's range is decided, so the commands, the input
// rule and the paste rule cannot disagree about it. The tokeniser rejects a
// highlight bounded by whitespace, so the range moves inward past whitespace
// and past anything with no text of its own: the gap between blocks, a hard
// break, an inline formula, which a mark does not stay on anyway (#66).
function trimmed(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): [number, number] | null {
  const blank = (pos: number) => /^\s*$/.test(doc.textBetween(pos, pos + 1, ' ', ' '))
  while (from < to && blank(from)) from += 1
  while (to > from && blank(to - 1)) to -= 1
  return from < to ? [from, to] : null
}

// Typing and pasting both arrive here. An input rule runs before the closing
// `=` reaches the document and a paste rule after, which is why the closing
// delimiter is cut to range.to rather than by length.
const unwrapHighlight =
  (type: MarkType) =>
  ({
    state,
    range,
    match,
  }: {
    state: { tr: Transaction }
    range: { from: number; to: number }
    match: RegExpMatchArray
  }) => {
    const [full, wrapped, text] = match
    if (full === undefined || wrapped === undefined || text === undefined) return
    const open = range.from + full.indexOf(wrapped)
    const { tr } = state
    // The closing delimiter first, so the opening one's positions still hold.
    tr.delete(open + 2 + text.length, range.to)
    tr.delete(open, open + 2)
    const ends = trimmed(tr.doc, open, open + text.length)
    if (ends !== null) tr.addMark(ends[0], ends[1], type.create())
    tr.removeStoredMark(type)
  }

// Judged on the trimmed selection, so a selection taken with its spaces reads
// as highlighted, and toggles off, exactly like one taken without them. The
// bubble menu's pressed state asks this too, or a double-click that picked up
// a trailing space shows the button off while pressing it removes the mark.
function highlightCovered(state: EditorState) {
  const type = state.schema.marks.highlight
  let text = false
  let covered = true
  for (const { $from, $to } of state.selection.ranges) {
    const ends = trimmed(state.doc, $from.pos, $to.pos)
    if (ends === null || type === undefined) continue
    state.doc.nodesBetween(ends[0], ends[1], (node) => {
      if (!node.isText) return
      text = true
      if (!type.isInSet(node.marks)) covered = false
    })
  }
  return text && covered
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlight: {
      setHighlight: () => ReturnType
      unsetHighlight: () => ReturnType
      toggleHighlight: () => ReturnType
    }
  }
}

// Every `=` that another `=` follows is saved with a backslash, so text that
// was literal when saved reads back literal: `==` is written `\==`. No
// extension hook reaches text serialisation, so this wraps
// escapeMarkdownSyntax, an internal method of @tiptap/markdown's manager that
// escapes \ ` * _ [ ] ~ and not `=`. TipTap is pinned exactly, and the round
// trip in constructsSurvive.test.ts fails if an upgrade stops calling it.
//
// A note saved before this existed can hold a literal ==x==, and it loads as a
// highlight: the characters are identical and no parser can tell which was
// meant. Escaping disambiguates only what is saved from now on.
const Highlight = Mark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: () => ['mark', 0],
  markdownTokenName: 'highlight',
  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start: (src) => src.indexOf('=='),
    tokenize: (src, _tokens, lexer) => {
      const match = HIGHLIGHT.exec(src)
      if (match === null || /\s$/.test(match[1]!)) return undefined
      return {
        type: 'highlight',
        raw: match[0],
        text: match[1],
        tokens: lexer.inlineTokens(match[1]!),
      }
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('highlight', helpers.parseInline(token.tokens ?? [])),
  renderMarkdown: (node, helpers) => `==${helpers.renderChildren(node)}==`,
  onBeforeCreate() {
    // Cast, because the method is private in the typings. Checked, because
    // assigning to a name the manager no longer has would do nothing at all.
    const manager = this.editor.markdown as unknown as
      | { escapeMarkdownSyntax?: (text: string) => string }
      | undefined
    const escape = manager?.escapeMarkdownSyntax
    if (manager === undefined || typeof escape !== 'function') {
      throw new Error(
        'highlight: @tiptap/markdown has no escapeMarkdownSyntax, so a literal == would save unescaped',
      )
    }
    manager.escapeMarkdownSyntax = (text) =>
      escape.call(manager, text).replace(/=(?==)/g, '\\=')
  },
  addCommands() {
    return {
      setHighlight:
        () =>
        ({ state, tr, dispatch }) => {
          const ranges = state.selection.ranges.flatMap(({ $from, $to }) => {
            const ends = trimmed(state.doc, $from.pos, $to.pos)
            return ends === null ? [] : [ends]
          })
          if (ranges.length === 0) return false
          if (dispatch) {
            for (const [from, to] of ranges) tr.addMark(from, to, this.type.create())
          }
          return true
        },
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
      toggleHighlight:
        () =>
        ({ state, commands }) =>
          highlightCovered(state) ? commands.unsetHighlight() : commands.setHighlight(),
    }
  },
  addInputRules() {
    return [new InputRule({ find: HIGHLIGHT_TYPED, handler: unwrapHighlight(this.type) })]
  },
  addPasteRules() {
    return [new PasteRule({ find: HIGHLIGHT_PASTED, handler: unwrapHighlight(this.type) })]
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-h': () => this.editor.commands.toggleHighlight() }
  },
})

// StarterKit does not export its parts, and importing
// @tiptap/extension-hard-break directly would be a dependency package.json
// does not declare. These are the instances StarterKit itself would load.
function fromStarterKit(name: string) {
  const found = flattenExtensions([StarterKit]).find((extension) => extension.name === name)
  if (found === undefined) throw new Error(`StarterKit no longer ships ${name}`)
  return found as TipTapNode
}

// Above zero while a table is being written. A table turns each newline in a
// cell into `<br>`, and a backslash in front of that escapes the `<`, so a
// break in a cell would reopen as the text "<br>". Rendering is synchronous,
// which is what makes a counter enough.
let renderingTable = 0

const renderTable = getExtensionField<NonNullable<typeof Table.config.renderMarkdown>>(
  Table,
  'renderMarkdown',
)

const MarkdownTable = Table.extend({
  renderMarkdown(node, helpers, ctx) {
    renderingTable += 1
    try {
      return renderTable?.(node, helpers, ctx) ?? ''
    } finally {
      renderingTable -= 1
    }
  },
})

// A trailing backslash rather than StarterKit's two trailing spaces, which
// nothing shows and most editors and git hooks delete: a note edited anywhere
// else would lose its line breaks without a trace. Both read back the same.
// Inside a table, the spaces, which the table turns into `<br>` anyway.
const LineBreak = fromStarterKit('hardBreak').extend({
  renderMarkdown: () => (renderingTable > 0 ? '  \n' : '\\\n'),
})

// A line that starts like a list, a heading or a setext underline is read
// back as one: `a\` + `- b` reopens as a paragraph and a list, and so does a
// paragraph whose own text begins `- `, which is what Backspace leaves after
// undoing the list rule. So every line start is escaped, the first included.
// A backslash before punctuation reads back as the punctuation, so this is
// safe on any line, a soft break from markdown written elsewhere included.
const escapeLineStart = (line: string) =>
  line
    .replace(/^(\s*)(\d{1,9})([.)])(?=\s|$)/, '$1$2\\$3')
    .replace(/^(\s*)(#{1,6}(?=\s|$)|[-+](?=\s|$)|=+\s*$|-+\s*$)/, '$1\\$2')

const paragraph = fromStarterKit('paragraph')
const renderParagraph = getExtensionField<NonNullable<typeof paragraph.config.renderMarkdown>>(
  paragraph,
  'renderMarkdown',
)

const ProseParagraph = paragraph.extend({
  renderMarkdown(node, helpers, ctx) {
    // A backslash that ends a paragraph is a literal backslash, and the cursor
    // sits after a trailing break every time Enter is pressed at the end of a
    // line, so a save in that moment would reopen with `\` in the text.
    const content = [...(node.content ?? [])]
    while (content.at(-1)?.type === 'hardBreak') content.pop()
    const rendered = renderParagraph?.({ ...node, content }, helpers, ctx) ?? ''
    // A cell is one line in the file, its breaks written as `<br>`, so no
    // line in it starts anything.
    if (renderingTable > 0) return rendered
    return rendered
      .split('\n')
      .map(escapeLineStart)
      .join('\n')
  },
})

// Paragraphs only, and not the paragraph inside a list item or a table cell,
// where Enter keeps meaning the next item or the cell's own split. A heading
// is left to the defaults too: a markdown heading is one line.
function inProse($from: ResolvedPos) {
  if ($from.parent.type.name !== 'paragraph') return false
  const holder = $from.node(-1).type.name
  return holder === 'doc' || holder === 'blockquote'
}

// The stock markdown rules only look at the start of a block, and after a line
// break the cursor is not there, so a sentence, Enter, `- ` stayed text. The
// text these see has the break as `\n`, and every pattern starts at it: the
// marker has to open the line, so `a - b` stays prose. Each makes exactly what
// the stock rule of the same pattern makes at the start of a block, and no
// more — two markdown dialects in one editor would leave nobody able to say
// which one they are typing in.
const AFTER_BREAK: [RegExp, (chain: ChainedCommands, match: string[]) => ChainedCommands][] = [
  [/\n\s*([-+*])\s$/, (chain) => chain.toggleBulletList()],
  [
    /\n(\d+)\.\s$/,
    (chain, match) =>
      chain.toggleOrderedList().updateAttributes('orderedList', { start: Number(match[1]) }),
  ],
  [/\n\s*>\s$/, (chain) => chain.toggleBlockquote()],
  [/\n(#{1,6})\s$/, (chain, match) => chain.setNode('heading', { level: match[1]!.length })],
  [
    /\n\s*(\[([( |x])?\])\s$/,
    (chain, match) =>
      chain.toggleTaskList().updateAttributes('taskItem', { checked: match[2] === 'x' }),
  ],
]

// Reported from the marker on, not from the break. The runner checks the
// matched text against the document's own text, in which a break is nothing
// at all, and a match that starts with `\n` never agrees with it.
const fromMarker = (pattern: RegExp) => (text: string) => {
  const found = pattern.exec(text)
  if (found === null) return null
  return { index: found.index + 1, text: found[0].slice(1), data: { groups: [...found] } }
}

const LineBreaks = Extension.create({
  name: 'lineBreaks',
  // Ahead of HardBreak's Shift-Enter and the core Enter, which both still run
  // wherever these return false.
  priority: 1000,
  // One transaction each, which is what lets Backspace undo the rule as it
  // undoes a stock one: the break and the literal marker come back.
  addInputRules() {
    return AFTER_BREAK.map(
      ([find, makeBlock]) =>
        new InputRule({
          find: fromMarker(find),
          handler: ({ state, range, match, chain }) => {
            const $marker = state.doc.resolve(range.from)
            if (!inProse($marker)) return null
            // One position back is the break, or a newline kept in the text
            // from markdown written elsewhere, which also starts a line.
            const at = range.from - 1
            // A break that opens the paragraph has nothing before it to keep.
            const split = at > $marker.start()
            const cut = chain().deleteRange({ from: at, to: range.to })
            makeBlock(split ? cut.splitBlock() : cut, match.data!.groups as string[]).run()
          },
        }),
    )
  },
  addKeyboardShortcuts() {
    const newBlock = () =>
      this.editor.commands.first(({ commands }) => [
        () => commands.liftEmptyBlock(),
        () => commands.splitBlock(),
      ])
    return {
      Enter: () => {
        const { $from, empty } = this.editor.state.selection
        // An empty paragraph keeps the default, which is also how a quote is
        // left: Enter in its empty last paragraph lifts out of it.
        if (!inProse($from) || $from.parent.content.size === 0) return false
        // Enter on an empty line ends the paragraph instead of adding another
        // break. Not redundant with Shift+Enter: the iPad's on-screen keyboard
        // does not reliably send Shift with Return, and without this an iPad
        // has no way to start a new block at all.
        const { nodeBefore, nodeAfter } = $from
        if (
          empty &&
          nodeBefore?.type.name === 'hardBreak' &&
          (nodeAfter === null || nodeAfter.type.name === 'hardBreak')
        ) {
          return this.editor
            .chain()
            .deleteRange({ from: $from.pos - 1, to: $from.pos + (nodeAfter === null ? 0 : 1) })
            .splitBlock()
            .run()
        }
        return this.editor.commands.setHardBreak()
      },
      'Shift-Enter': () => {
        const { $from } = this.editor.state.selection
        // A heading as well, where HardBreak's own binding would put a break
        // into a line markdown cannot break.
        if (inProse($from) || $from.parent.type.name === 'heading') return newBlock()
        return false
      },
    }
  },
})

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
      hardBreak: false,
      paragraph: false,
      link: {
        openOnClick: false,
        // The extension's default rel is 'noopener noreferrer nofollow'.
        // nofollow withholds ranking credit from a page you link to, which is
        // a publisher's concern; these notes are private and are not a page.
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      },
    }),
    LineBreak,
    ProseParagraph,
    LineBreaks,
    Markdown,
    // After Markdown, whose manager it wraps as the editor is created.
    Highlight,
    // Present so `![alt](url)` keeps its URL. There is no upload, no paste
    // handling and no UI: not eating an existing construct is not the same as
    // implementing images.
    Image,
    TableKit.configure({ table: false }),
    MarkdownTable,
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
    TopicHighlight,
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

// Long enough to find on a screen that just scrolled, short enough to be gone
// before reading starts.
const FLASH_MS = 2000

type Controls = { editor: TipTap; top: number }

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
  // The heading to land on, for a note opened from a deadline's topic. Only
  // ever one that is in the body: a missing heading is reported by the caller,
  // which has the body before this mounts.
  jump?: string | null
}

export default function Editor({
  noteId,
  initialBody,
  label,
  mathLabel,
  focus,
  onChange,
  jump = null,
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
  // A position inside the block the pointer is over, or null when the pointer
  // is outside the editor. While it is set the controls outline that block and
  // ignore the cursor; while it is null they follow the cursor, so they are
  // still there for the keyboard.
  const hovered = useRef<number | null>(null)
  const [blocks, setBlocks] = useState<Blocks | null>(null)
  // Mirrored for the same reason menuNow is: the handlers below are captured
  // when the editor is built and would otherwise read the state as it was on
  // mount.
  const blocksNow = useRef<Blocks | null>(null)
  const editingNow = useRef<Editing | null>(null)
  const [controls, setControls] = useState<Controls | null>(null)
  // Mirrored for the same reason again: refresh and track must not open a
  // second surface while this one is up.
  const controlsNow = useRef<Controls | null>(null)
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

  const control = useCallback((next: Controls | null) => {
    controlsNow.current = next
    setControls(next)
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
    if (
      !(selection instanceof TextSelection) ||
      selection.empty ||
      controlsNow.current !== null
    ) {
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
    // Held while a menu is open: it acts on the block it was opened beside,
    // and the controls must stay beside that block.
    if (blocksNow.current === null && controlsNow.current === null) {
      anchorAt(current, box, hovered.current ?? selection.from)
    }

    // The + button's menu is not driven by the text and must not be closed by
    // it: opening it moves the selection, which lands right back here.
    const open = blocksNow.current
    if ((open !== null && open.slash === null) || controlsNow.current !== null) return

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

  const closeControls = useCallback(
    (refocus: boolean) => {
      control(null)
      if (refocus) view.current?.commands.focus(null, KEEP)
    },
    [control],
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
      onUpdate: ({ editor, transaction }) => {
        // Text typed in a block above the hovered one pushes it down. Unmapped,
        // the stored position lands in a different block, and the menu opened
        // from the controls beside it acts on that one instead.
        if (hovered.current !== null) {
          hovered.current = transaction.mapping.map(hovered.current)
        }
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
      control(null)
    }
  }, [
    closeBlock,
    control,
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
      // Before the content goes, so the cursor move below finds nothing open to
      // hold the controls in place. A menu opened against the old document
      // acts on the cursor's block, and the cursor is about to be clamped into
      // some other block than the one the menu sits beside. The hovered
      // position points into the old document too, and no mapping reaches a
      // document that was replaced wholesale.
      show(null)
      control(null)
      hovered.current = null
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
  }, [control, noteId, show])

  // A subscription and not a read on mount, for the reason the one above
  // watches the note: a deadline added anywhere has to light up a heading in a
  // note that is already open. Compared before dispatching, because ticking a
  // deadline off also wakes this and changes nothing here.
  const marked = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    marked.current = new Set()
    const subscription = observeDeadlines().subscribe((rows) => {
      const current = view.current
      const names = namedIn(rows, noteId)
      if (current === null || sameNames(names, marked.current)) return
      marked.current = names
      markTopics(current, { names })
    })
    return () => subscription.unsubscribe()
  }, [noteId])

  useEffect(() => {
    const current = view.current
    if (current === null || jump === null) return
    const pos = headingAt(current.state.doc, jump)
    if (pos === null) return
    const dom = current.view.nodeDOM(pos)
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start' })
    markTopics(current, { flash: jump })
    const timer = setTimeout(() => markTopics(current, { flash: null }), FLASH_MS)
    return () => clearTimeout(timer)
  }, [jump, noteId])

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
    control(null)
    current.commands.setTextSelection(anchor.pos)
    show({ top: anchor.top + BUTTON, left: 0, filter: '', slash: null, picked: 0 })
  }

  const openControls = () => {
    const current = view.current
    if (current === null || anchor === null || editingNow.current !== null) return
    show(null)
    const { doc, selection } = current.state
    // Into the block the handle is beside, unless the cursor is already there:
    // moving it would throw away the table cell it sits in, and the table
    // commands act on that cell. Selection.near because the start of a table
    // is not a text position, and near finds its first cell.
    if (doc.resolve(anchor.pos).index(0) !== selection.$from.index(0)) {
      current.commands.command(({ tr }) => {
        tr.setSelection(Selection.near(tr.doc.resolve(anchor.pos)))
        return true
      })
    }
    control({ editor: current, top: anchor.top + BUTTON })
    place(null)
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
        if (
          current === null ||
          box === null ||
          blocksNow.current !== null ||
          controlsNow.current !== null
        ) {
          return
        }
        const found = current.view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })
        if (found === null) return
        hovered.current = found.pos
        anchorAt(current, box, found.pos)
      }}
      onMouseLeave={() => {
        const current = view.current
        const box = scroll.current
        hovered.current = null
        if (current === null || box === null) return
        if (blocksNow.current !== null || controlsNow.current !== null) return
        anchorAt(current, box, current.state.selection.from)
      }}
    >
      <div ref={host} />
      {anchor !== null && (
        // A menu button and not a drag source, whatever the grip suggests.
        // Dragging to reorder is out of scope; Move up and Move down in the
        // menu are how a block moves. Wiring drag events here means building
        // that feature, not finishing this one.
        <button
          type="button"
          className="block-handle"
          aria-label={t('editor.blockOptions')}
          aria-haspopup="menu"
          aria-expanded={controls !== null}
          style={{ top: `${anchor.top}px` } as CSSProperties}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onClick={openControls}
        >
          <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
            {[2, 8].flatMap((cx) =>
              [2, 8, 14].map((cy) => (
                <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.5" fill="currentColor" />
              )),
            )}
          </svg>
        </button>
      )}
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
      {controls !== null && (
        <BlockControls editor={controls.editor} top={controls.top} onClose={closeControls} />
      )}
      {menu !== null && (
        <BubbleMenu
          ref={menuEl}
          editor={menu.editor}
          top={menu.top}
          left={menu.left}
          below={menu.below}
          link={menu.link}
          highlighted={highlightCovered(menu.editor.state)}
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
