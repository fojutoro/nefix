import { describe, expect, it } from 'vitest'
import { normalize } from './normalize.ts'

// Every Slovak letter that carries a diacritic, against the base letter a
// user types instead of it.
const SLOVAK: [string, string][] = [
  ['á', 'a'],
  ['ä', 'a'],
  ['č', 'c'],
  ['ď', 'd'],
  ['é', 'e'],
  ['í', 'i'],
  ['ĺ', 'l'],
  ['ľ', 'l'],
  ['ň', 'n'],
  ['ó', 'o'],
  ['ô', 'o'],
  ['ŕ', 'r'],
  ['š', 's'],
  ['ť', 't'],
  ['ú', 'u'],
  ['ý', 'y'],
  ['ž', 'z'],
]

describe('normalize', () => {
  it.each(SLOVAK)('folds %s onto %s', (accented, base) => {
    expect(normalize(accented)).toBe(base)
    expect(normalize(accented.toUpperCase())).toBe(base)
  })

  it('folds a whole word', () => {
    expect(normalize('Diskrétna matematika')).toBe('diskretna matematika')
    expect(normalize('Ľubovoľný ťažký deň')).toBe('lubovolny tazky den')
  })

  it('lowercases', () => {
    expect(normalize('ĎAKUJEM')).toBe('dakujem')
  })

  it('collapses runs of whitespace and trims', () => {
    expect(normalize('  teória \n\t  grafov  ')).toBe('teoria grafov')
  })

  it('leaves a string with no diacritics alone', () => {
    expect(normalize('linearna algebra 2')).toBe('linearna algebra 2')
  })

  it('returns an empty string for whitespace', () => {
    expect(normalize('   \n ')).toBe('')
  })
})
