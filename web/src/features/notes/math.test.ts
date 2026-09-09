import { describe, expect, it } from 'vitest'
import { findMath, type MathKind } from './math.ts'

type Found = { source: string; content: string; kind: MathKind }

// The range is asserted by slicing the document with it, so a case reads as
// the text it covers rather than as a pair of offsets.
const found = (text: string): Found[] =>
  findMath(text).map((range) => ({
    source: text.slice(range.from, range.to),
    content: range.content,
    kind: range.kind,
  }))

const cases: { name: string; text: string; expected: Found[] }[] = [
  {
    name: 'a single dollar pair is inline math',
    text: 'the sum $x$ of it',
    expected: [{ source: '$x$', content: 'x', kind: 'inline' }],
  },
  {
    name: 'a double dollar pair is display math',
    text: 'the sum $$x$$ of it',
    expected: [{ source: '$$x$$', content: 'x', kind: 'display' }],
  },
  {
    name: 'an escaped dollar does not open a formula',
    text: 'it costs \\$5 today, and \\$x\\$ is not math',
    expected: [],
  },
  {
    name: 'currency in prose is not a formula',
    text: '$5 and $10',
    expected: [],
  },
  {
    name: 'an unterminated dollar is not a formula',
    text: 'the sum $x + 1 and no closing delimiter',
    expected: [],
  },
  {
    name: 'a dollar followed by whitespace does not open a formula',
    text: 'paid $ 5 and $ 10',
    expected: [],
  },
  {
    name: 'math inside a fenced block is ignored, and the fence closes',
    text: '```\n$x$\n```\n\n$y$\n',
    expected: [{ source: '$y$', content: 'y', kind: 'inline' }],
  },
  {
    name: 'math inside backticks is ignored',
    text: 'write `$x$` to get $x$',
    expected: [{ source: '$x$', content: 'x', kind: 'inline' }],
  },
  {
    name: 'several formulas on one line',
    text: '$a$ and $b$ and $$c$$',
    expected: [
      { source: '$a$', content: 'a', kind: 'inline' },
      { source: '$b$', content: 'b', kind: 'inline' },
      { source: '$$c$$', content: 'c', kind: 'display' },
    ],
  },
  {
    name: 'display math spans lines',
    text: 'before\n$$\n\\frac{a}{b}\n$$\nafter',
    expected: [
      {
        source: '$$\n\\frac{a}{b}\n$$',
        content: '\n\\frac{a}{b}\n',
        kind: 'display',
      },
    ],
  },
  {
    name: 'inline math does not span lines',
    text: 'the sum $x\nand $y$ too',
    expected: [{ source: '$y$', content: 'y', kind: 'inline' }],
  },
  {
    name: 'a dollar escaped inside a formula does not close it',
    text: '$a \\$ b$',
    expected: [{ source: '$a \\$ b$', content: 'a \\$ b', kind: 'inline' }],
  },
]

describe('findMath', () => {
  for (const { name, text, expected } of cases) {
    it(name, () => {
      expect(found(text)).toEqual(expected)
    })
  }
})
