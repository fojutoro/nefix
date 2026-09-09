import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import katex from 'katex'
import { findMath, type MathKind } from './math.ts'

class MathWidget extends WidgetType {
  readonly content: string
  readonly kind: MathKind

  constructor(content: string, kind: MathKind) {
    super()
    this.content = content
    this.kind = kind
  }

  eq(other: MathWidget) {
    return other.content === this.content && other.kind === this.kind
  }

  toDOM() {
    const host = document.createElement('span')
    host.className = 'cm-math'
    // throwOnError: false, because a half-typed formula is the normal state
    // while typing. KaTeX renders its own error markup for one; a throw here
    // would take the editor down with it.
    host.innerHTML = katex.renderToString(this.content, {
      displayMode: this.kind === 'display',
      throwOnError: false,
    })
    return host
  }

  // So a click lands in the document underneath and moves the cursor into the
  // source rather than being swallowed by the widget.
  ignoreEvent() {
    return false
  }
}

// The whole document, not the viewport: a fenced code block is only known from
// its opening line, which scrolls out of view while the lines it governs do
// not.
function mathDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const text = view.state.doc.toString()

  for (const range of findMath(text)) {
    // Editing something you cannot see is unusable, so the formula the cursor
    // is in stays source. Touching an end counts as being in it, which is what
    // lets a click on the widget open it up.
    const held = view.state.selection.ranges.some(
      (selection) => selection.from <= range.to && selection.to >= range.from,
    )
    if (held) continue
    builder.add(
      range.from,
      range.to,
      Decoration.replace({ widget: new MathWidget(range.content, range.kind) }),
    )
  }

  return builder.finish()
}

export const mathExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = mathDecorations(view)
    }

    // Only these two: rebuilding on every update is a re-render of every
    // formula per scroll event.
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = mathDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
