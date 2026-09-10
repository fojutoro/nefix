import { describe, expect, it } from 'vitest'
import { outline } from './outline.ts'

const cases: [name: string, bodyMd: string, expected: string[]][] = [
  ['no headings at all', 'Množiny\nNech A a B sú množiny.', []],
  ['an empty body', '', []],
  [
    'the first line, which is already the title',
    '# Množiny\n## Definícia\n## Operácie',
    ['Definícia', 'Operácie'],
  ],
  [
    'the first line with blanks above it, which is still the title',
    '\n\n# Množiny\n## Definícia',
    ['Definícia'],
  ],
  [
    'a plain first line, which takes no heading with it',
    'Množiny\n# Definícia',
    ['Definícia'],
  ],
  [
    'all six levels, in document order',
    'Title\n# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six',
    ['One', 'Two', 'Three', 'Four', 'Five', 'Six'],
  ],
  ['seven hashes, which is not a heading', 'Title\n####### Nope', []],
  ['a hash with no space, which is not a heading', 'Title\n#Nope', []],
  [
    'a fenced block, where a hash is a comment',
    'Title\n```go\n# not a heading\n```\n## Definícia',
    ['Definícia'],
  ],
  [
    'a tilde fence, which fences the same way',
    'Title\n~~~\n# not a heading\n~~~\n## Definícia',
    ['Definícia'],
  ],
  [
    'an unclosed fence, which swallows the rest',
    'Title\n```\n# not a heading\n## also not',
    [],
  ],
  [
    'a fence opening the body, so the line after it is not the title',
    '```\n# not a heading\n```\n# Definícia',
    ['Definícia'],
  ],
  [
    'closed ATX headings, which keep their text and lose their hashes',
    'Title\n## Definícia ##',
    ['Definícia'],
  ],
  [
    'indented headings, up to the three spaces markdown allows',
    'Title\n   ## Definícia\n    #### Code, not a heading',
    ['Definícia'],
  ],
  [
    'surrounding whitespace, which is not part of the heading',
    'Title\n##    Definícia   ',
    ['Definícia'],
  ],
]

describe('outline', () => {
  for (const [name, bodyMd, expected] of cases) {
    it(`extracts nothing from ${name}`.replace('nothing from ', ''), () => {
      expect(outline(bodyMd)).toEqual(expected)
    })
  }
})
