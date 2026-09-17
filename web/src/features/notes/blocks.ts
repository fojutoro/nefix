import type { Editor as TipTap } from '@tiptap/core'
import { Selection } from '@tiptap/pm/state'

// The document never loses focus while a command runs and the block it acts on
// is on screen by definition, so there is nothing to scroll to. Same reasoning
// as the bubble menu's KEEP.
export const KEEP = { scrollIntoView: false }

// Called with the position of a display maths node that was just inserted
// empty. An empty block maths node renders as an empty box with no way to fill
// it, so the source field has to be opened over it — the same bargain the
// `$$ ` input rule makes in Editor.tsx.
export type OpenBlockMath = (pos: number) => void

export type Translate = (key: string, args?: Record<string, number>) => string

export type BlockCommand = {
  id: string
  labelKey: string
  labelArgs?: Record<string, number>
  // English, and matched alongside the translated label rather than instead of
  // it. `/head` is muscle memory whatever language the interface is set to,
  // and a Slovak user typing `/nadpis` finds the same command through the
  // label. Lowercase, because the filter is lowercased once and compared raw.
  keywords: string[]
  run: (editor: TipTap, openMath: OpenBlockMath) => void
}

const heading = (level: 1 | 2 | 3): BlockCommand => ({
  id: `heading${level}`,
  // The bubble menu's key, not a second one saying the same words. One label
  // for one concept, so a heading cannot be called two different things in two
  // places in the same editor.
  labelKey: 'editor.heading',
  labelArgs: { level },
  keywords: ['heading', 'title', `h${level}`],
  run: (editor) => {
    editor.chain().focus(null, KEEP).setNode('heading', { level }).run()
  },
})

// The one definition. Both triggers render this array and both run these
// functions, so a command added here appears in the slash menu and under the
// + button at once and the two cannot drift apart.
export const BLOCKS: BlockCommand[] = [
  heading(1),
  heading(2),
  heading(3),
  {
    id: 'bulletList',
    labelKey: 'block.bulletList',
    keywords: ['bullet', 'list', 'unordered', 'ul'],
    run: (editor) => {
      editor.chain().focus(null, KEEP).toggleBulletList().run()
    },
  },
  {
    id: 'orderedList',
    labelKey: 'block.orderedList',
    keywords: ['number', 'ordered', 'list', 'ol'],
    run: (editor) => {
      editor.chain().focus(null, KEEP).toggleOrderedList().run()
    },
  },
  {
    id: 'taskList',
    labelKey: 'block.taskList',
    keywords: ['task', 'todo', 'checkbox', 'checklist'],
    run: (editor) => {
      editor.chain().focus(null, KEEP).toggleTaskList().run()
    },
  },
  {
    id: 'blockquote',
    labelKey: 'block.quote',
    keywords: ['quote', 'blockquote', 'citation'],
    run: (editor) => {
      editor.chain().focus(null, KEEP).toggleBlockquote().run()
    },
  },
  {
    id: 'codeBlock',
    labelKey: 'block.codeBlock',
    keywords: ['code', 'pre', 'snippet'],
    run: (editor) => {
      editor.chain().focus(null, KEEP).toggleCodeBlock().run()
    },
  },
  {
    id: 'table',
    labelKey: 'block.table',
    keywords: ['table', 'grid', 'rows'],
    run: (editor) => {
      editor
        .chain()
        .focus(null, KEEP)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run()
    },
  },
  {
    id: 'divider',
    labelKey: 'block.divider',
    keywords: ['divider', 'rule', 'separator', 'hr'],
    run: (editor) => {
      editor.chain().focus(null, KEEP).setHorizontalRule().run()
    },
  },
  {
    id: 'blockMath',
    labelKey: 'block.math',
    keywords: ['math', 'maths', 'formula', 'equation', 'latex', 'katex'],
    run: (editor, openMath) => {
      const { $from } = editor.state.selection
      // insertBlockMath refuses an empty latex string, and display maths has
      // to start empty — there is nothing to type into it until the source
      // field opens. Replacing an empty block and inserting after a full one
      // is what keeps `hello /math` from swallowing the word hello.
      const blank = $from.parent.content.size === 0
      const at = blank ? $from.before() : $from.after()
      editor
        .chain()
        .focus(null, KEEP)
        .insertContentAt(
          { from: at, to: blank ? $from.after() : at },
          { type: 'blockMath', attrs: { latex: '' } },
        )
        .run()
      openMath(at)
    },
  },
]

// Not in BLOCKS: a paragraph is what the + inserts before running any of them,
// so offering it there would be a command that does nothing. clearNodes rather
// than setParagraph, so a quote turned into a paragraph leaves the quote.
const PARAGRAPH: BlockCommand = {
  id: 'paragraph',
  labelKey: 'editor.paragraph',
  keywords: ['paragraph', 'text'],
  run: (editor) => {
    editor.chain().focus(null, KEEP).clearNodes().run()
  },
}

const CONVERTIBLE = ['heading1', 'heading2', 'heading3', 'blockquote', 'codeBlock']

export const TURN_INTO: BlockCommand[] = [
  PARAGRAPH,
  ...BLOCKS.filter((command) => CONVERTIBLE.includes(command.id)),
]

// The top-level node the selection is in: the block the handle stands beside,
// and the same one the + inserts under.
function topBlock(editor: TipTap) {
  const { doc, selection } = editor.state
  const { $from } = selection
  const index = Math.min($from.index(0), doc.childCount - 1)
  const from = $from.posAtIndex(index, 0)
  const node = doc.child(index)
  return { index, node, from, to: from + node.nodeSize, offset: selection.from - from }
}

export function deleteBlock(editor: TipTap) {
  const { from, to } = topBlock(editor)
  const { doc, schema } = editor.state
  editor
    .chain()
    .focus(null, KEEP)
    .command(({ tr }) => {
      // The document may not be empty, so the last block leaves an empty
      // paragraph behind rather than a transaction ProseMirror has to repair.
      if (doc.childCount === 1) tr.replaceWith(from, to, schema.nodes.paragraph!.create())
      else tr.delete(from, to)
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))))
      return true
    })
    .run()
}

export function duplicateBlock(editor: TipTap) {
  const { node, to } = topBlock(editor)
  editor.chain().focus(null, KEEP).insertContentAt(to, node.toJSON()).run()
}

export function canShiftBlock(editor: TipTap, delta: -1 | 1) {
  const target = topBlock(editor).index + delta
  return target >= 0 && target < editor.state.doc.childCount
}

// Swaps with the neighbour and keeps the cursor where it was inside the block,
// so moving twice in a row moves the same block twice.
export function shiftBlock(editor: TipTap, delta: -1 | 1) {
  if (!canShiftBlock(editor, delta)) return
  const { index, node, from, to, offset } = topBlock(editor)
  const neighbour = editor.state.doc.child(index + delta)
  const at = delta === 1 ? from + neighbour.nodeSize : from - neighbour.nodeSize
  editor
    .chain()
    .focus(null, KEEP)
    .command(({ tr }) => {
      tr.delete(from, to).insert(at, node)
      tr.setSelection(Selection.near(tr.doc.resolve(at + offset)))
      return true
    })
    .run()
}

// Matched against the translated label and the English keywords together, so
// the list narrows the same way in either language.
export function filterBlocks(filter: string, t: Translate) {
  const needle = filter.toLowerCase()
  return BLOCKS.map((command) => ({
    command,
    label: t(command.labelKey, command.labelArgs),
  })).filter(
    ({ command, label }) =>
      needle === '' ||
      label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle)),
  )
}

export type Labelled = ReturnType<typeof filterBlocks>[number]
