import type { Editor as TipTap } from '@tiptap/core'

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
