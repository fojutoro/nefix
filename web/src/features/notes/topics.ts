import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Deadline } from '../../db/schema.ts'

// The headings a deadline names, painted where they sit in the note. A
// decoration and never a mark: a mark is part of the document, and anything in
// the document is written back into the markdown on the next save.

type Marks = { names: ReadonlySet<string>; flash: string | null }
type State = { marks: Marks; set: DecorationSet }

const key = new PluginKey<State>('topics')

export function namedIn(deadlines: Deadline[], noteId: string): Set<string> {
  const names = new Set<string>()
  for (const deadline of deadlines) {
    for (const topic of deadline.topics) {
      if (topic.noteId === noteId) names.add(topic.heading)
    }
  }
  return names
}

export const sameNames = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((name) => b.has(name))

// Trimmed, because outline() trims the heading a topic was picked from.
function eachHeading(
  doc: ProseNode,
  visit: (text: string, pos: number, node: ProseNode) => void,
): void {
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      visit(node.textContent.trim(), pos, node)
      return false
    }
    // A heading can sit in a list or a quote, never inside a paragraph.
    return !node.isTextblock
  })
}

function decorate(doc: ProseNode, marks: Marks): DecorationSet {
  const found: Decoration[] = []
  eachHeading(doc, (text, pos, node) => {
    const flashing = text === marks.flash
    if (text === '' || (!flashing && !marks.names.has(text))) return
    found.push(
      Decoration.inline(pos + 1, pos + node.nodeSize - 1, {
        class: flashing ? 'topic-marked topic-flash' : 'topic-marked',
      }),
    )
  })
  return DecorationSet.create(doc, found)
}

export function headingAt(doc: ProseNode, heading: string): number | null {
  let at: number | null = null
  eachHeading(doc, (text, pos) => {
    if (at === null && text === heading) at = pos
  })
  return at
}

export function markTopics(editor: Editor, patch: Partial<Marks>): void {
  if (editor.isDestroyed) return
  // Out of the undo history: Cmd-Z must undo typing, not a deadline arriving.
  editor.view.dispatch(
    editor.state.tr.setMeta(key, patch).setMeta('addToHistory', false),
  )
}

export const TopicHighlight = Extension.create({
  name: 'topicHighlight',
  addProseMirrorPlugins() {
    const empty: Marks = { names: new Set(), flash: null }
    return [
      new Plugin<State>({
        key,
        state: {
          init: () => ({ marks: empty, set: DecorationSet.empty }),
          // Rebuilt rather than mapped on a document change: renaming a
          // heading changes whether it is named at all, which mapping the old
          // positions cannot know.
          apply: (tr, value, _old, state) => {
            const patch = tr.getMeta(key) as Partial<Marks> | undefined
            if (patch === undefined && !tr.docChanged) return value
            const marks = { ...value.marks, ...patch }
            return { marks, set: decorate(state.doc, marks) }
          },
        },
        props: { decorations: (state) => key.getState(state)?.set },
      }),
    ]
  },
})
