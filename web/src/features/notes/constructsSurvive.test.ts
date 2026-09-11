import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { editorExtensions } from './Editor.tsx'

// The extension list is a data-loss boundary. TipTap parses markdown into
// nodes, and a construct with no extension to model it is not an error
// anywhere — it is silently absent from the document and gone from the note
// the next time autosave runs. This fixture is the guard: add a construct to
// the app and forget its extension, and this breaks the build instead of
// eating somebody's notes.
//
// Nothing here may import the stock InlineMath. Tokeniser registration is
// process-wide and first-one-wins, so a stock registration anywhere in the
// suite would silently replace the corrected one under test.
function roundTrip(markdown: string): string {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: editorExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
  const out = editor.getMarkdown()
  editor.destroy()
  element.remove()
  return out
}

// Serialisation drops the trailing newline on every document, so comparing
// without it is comparing the part either side actually disagrees about.
const body = (markdown: string) => markdown.replace(/\n*$/, '')

// Everything the app supports, and every one of these must survive untouched.
const SURVIVES: Record<string, string> = {
  'atx headings': '# One\n\n## Two\n\n### Three',
  'bold and italic': 'Text with **bold** and *italic* words.',
  'strikethrough': 'Some ~~struck~~ text.',
  'inline code': 'Use `go vet` before committing.',
  'fenced code with language': '```go\nfunc main() {}\n```',
  'code fence holding dollars': '```\nprice = $x + $y\n```',
  'bullet list': '- first item\n- second item',
  'nested list': '- outer\n  - inner\n  - inner two\n- outer two',
  'ordered list': '1. first\n2. second\n3. third',
  'task list': '- [ ] undone\n- [x] done',
  'blockquote': '> quoted line\n> second line',
  'thematic break': 'above\n\n---\n\nbelow',
  'hard break': 'line one  \nline two',
  'link': 'A [link](https://example.com) here.',
  'image': '![alt text](https://example.com/a.png)',
  'inline maths': 'Inline $x^2$ math.',
  'display maths': '$$\na^2 + b^2 = c^2\n$$',
  // The reason math.ts is still here. The extension's own tokeniser turns
  // this into a formula and eats a space; findMath is what keeps prose prose.
  'money, which is not maths': 'It costs $5 and $10 today.',
}

// Rewritten but not damaged: every cell is still there and a second pass
// changes nothing further. Separated from the losses above because nothing is
// missing, and from the survivors because it is not byte-identical.
const REFORMATTED: Record<string, { from: string; to: string }> = {
  'table gains a leading blank line': {
    from: '| Term | Meaning      |\n| ---- | ------------ |\n| set  | a collection |',
    to: '\n| Term | Meaning      |\n| ---- | ------------ |\n| set  | a collection |',
  },
}

// One note holding the lot, because constructs interact: a list directly
// after a list is one list, and a serialiser that forgets a blank line turns
// two into one. Written out rather than joined from the fixtures above, so the
// separators are the ones a person would actually type.
const WHOLE = `# Diskrétna matematika

Text with **bold** and *italic* words, plus \`go vet\` and ~~struck~~ words.

## Definície

- first item
- second item

1. first
2. second

> A quoted definition.

- [ ] revise this
- [x] done already

A [link](https://example.com) and inline $x^2$ math. It costs $5 and $10 today.

$$
a^2 + b^2 = c^2
$$

\`\`\`go
func main() {}
\`\`\`

---

Last paragraph.`

// Chosen losses, not missed ones. TipTap publishes no footnote extension and
// no HTML passthrough, so these constructs cannot survive without writing
// extensions for them, which is a bigger PR than swapping an editor. They are
// asserted so that the day one of them starts working, this says so. The
// reasoning is written down in fojutoro/nefix#49.
const LOST: Record<string, { from: string; to: string }> = {
  'footnote': {
    from: 'Text[^1]\n\n[^1]: The note.',
    to: 'Text\\[^1\\]\n\n\\[^1\\]: The note.',
  },
  'raw html block': { from: '<div class="x">raw</div>', to: 'raw' },
  'html comment': { from: '<!-- a comment -->', to: '' },
}

describe('every construct the app supports survives a round trip', () => {
  for (const [name, markdown] of Object.entries(SURVIVES)) {
    it(name, () => {
      expect(body(roundTrip(markdown))).toBe(body(markdown))
    })
  }

  // A construct is only stable if a second pass changes nothing: a note that
  // is rewritten on every open turns a one-word edit into a whole-document
  // diff and marks the note dirty for nothing.
  it('is stable on a second pass', () => {
    for (const markdown of Object.values(SURVIVES)) {
      const once = roundTrip(markdown)
      expect(body(roundTrip(once))).toBe(body(once))
    }
  })

  it('round trips all of them together in one note', () => {
    expect(body(roundTrip(WHOLE))).toBe(body(WHOLE))
  })
})

describe('constructs that are rewritten but keep everything', () => {
  for (const [name, { from, to }] of Object.entries(REFORMATTED)) {
    it(name, () => {
      expect(body(roundTrip(from))).toBe(body(to))
      // And settles there rather than drifting further on every open.
      expect(body(roundTrip(to))).toBe(body(to))
    })
  }
})

describe('constructs known to be lost', () => {
  for (const [name, { from, to }] of Object.entries(LOST)) {
    it(`${name} is lost, and that was a decision`, () => {
      expect(body(roundTrip(from))).toBe(body(to))
    })
  }
})
