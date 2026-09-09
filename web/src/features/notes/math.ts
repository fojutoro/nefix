export type MathKind = 'inline' | 'display'

export type MathRange = {
  from: number
  to: number
  content: string
  kind: MathKind
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/

const isBlank = (char: string | undefined) =>
  char === undefined || /\s/.test(char)

const runLength = (text: string, start: number) => {
  let end = start
  while (text[end] === '`') end += 1
  return end - start
}

// A code span ends at a backtick run of the same length, not a longer one, so
// ``a ` b`` is one span rather than two.
const afterCodeSpan = (text: string, start: number, run: number) => {
  for (let i = start; i < text.length; i += 1) {
    if (text[i] !== '`') continue
    const length = runLength(text, i)
    if (length === run) return i + length
    i += length - 1
  }
  return -1
}

// The delimiter rule most markdown implementations use: an opening `$` is not
// followed by whitespace and a closing `$` is not preceded by it, which is what
// keeps "$5 and $10" out of the math. It applies to `$` alone. `$$` is not
// ambiguous with prose, and a display formula is normally written across lines
// of its own, so it is closed by the next `$$` wherever that falls.
function formulaAt(text: string, open: number): MathRange | null {
  const display = text.startsWith('$$', open)
  const start = open + (display ? 2 : 1)
  if (!display && isBlank(text[start])) return null

  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (display) {
      if (!text.startsWith('$$', i)) continue
      return { from: open, to: i + 2, content: text.slice(start, i), kind: 'display' }
    }
    // An unclosed `$` on one line is prose, not a formula that swallows the
    // rest of the note.
    if (text[i] === '\n') return null
    if (text[i] !== '$' || isBlank(text[i - 1])) continue
    return { from: open, to: i + 1, content: text.slice(start, i), kind: 'inline' }
  }
  return null
}

export function findMath(text: string): MathRange[] {
  const ranges: MathRange[] = []
  let fence: string | null = null
  let i = 0

  while (i < text.length) {
    if (i === 0 || text[i - 1] === '\n') {
      const lineEnd = text.indexOf('\n', i)
      const nextLine = lineEnd === -1 ? text.length : lineEnd + 1
      const line = text.slice(i, lineEnd === -1 ? text.length : lineEnd)
      const marker = FENCE.exec(line)?.[1] ?? null
      if (fence === null) {
        if (marker !== null) {
          fence = marker
          i = nextLine
          continue
        }
      } else {
        const closes =
          marker !== null &&
          marker[0] === fence[0] &&
          marker.length >= fence.length
        if (closes) fence = null
        i = nextLine
        continue
      }
    }

    const char = text[i]
    if (char === '\\') {
      // Not past a line ending, or the next line is never seen as one and a
      // fence opening on it is missed.
      i += text[i + 1] === '\n' ? 1 : 2
      continue
    }
    if (char === '`') {
      const run = runLength(text, i)
      const end = afterCodeSpan(text, i + run, run)
      i = end === -1 ? i + run : end
      continue
    }
    if (char === '$') {
      const formula = formulaAt(text, i)
      if (formula !== null) {
        ranges.push(formula)
        i = formula.to
        continue
      }
    }
    i += 1
  }

  return ranges
}
