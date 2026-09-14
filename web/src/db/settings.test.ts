import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  READABLE,
  contrast,
  parseHex,
  readSettings,
  writeSettings,
} from './settings.ts'

describe('readSettings', () => {
  it('answers with the defaults for a book that has set nothing', () => {
    expect(readSettings(null)).toEqual(DEFAULTS)
  })

  // A blob written by a newer client, or half-written, or corrupted in
  // storage. A reader that threw here would take down the whole book rather
  // than one setting.
  it('falls back to the defaults rather than throwing on a malformed blob', () => {
    for (const bad of ['', '{', 'null', '[]', '"a string"', '42', '{"a":']) {
      expect(readSettings(bad)).toEqual(DEFAULTS)
    }
  })

  // Per key, not per blob: one value this version cannot use must not cost
  // the user the eleven beside it.
  it('falls back key by key and keeps the values it can use', () => {
    const got = readSettings(
      JSON.stringify({
        ruling: 'hexagonal',
        pitch: 'wide',
        pageLines: 999,
        grain: -3,
        paper: 'not a colour',
        face: 'mono',
        ruleInset: 20,
      }),
    )
    expect(got.ruling).toBe(DEFAULTS.ruling)
    expect(got.pitch).toBe(DEFAULTS.pitch)
    expect(got.pageLines).toBe(DEFAULTS.pageLines)
    expect(got.grain).toBe(DEFAULTS.grain)
    expect(got.paper).toBe(DEFAULTS.paper)
    // The two that were usable survive the nine that were not.
    expect(got.face).toBe('mono')
    expect(got.ruleInset).toBe(20)
  })

  it('takes a hex colour in any form it accepts and stores one form', () => {
    expect(readSettings('{"paper":"fff"}').paper).toBe('#ffffff')
    expect(readSettings('{"ink":"#0A0b0C"}').ink).toBe('#0a0b0c')
  })
})

describe('writeSettings', () => {
  it('keeps a key this version has never heard of', () => {
    // The blob a newer client wrote. Round-tripping it through an older
    // client must not cost the user the setting: they would go back to the
    // new client and find it silently gone.
    const newer = JSON.stringify({ pitch: 2, marginDoodles: 'sunflowers' })
    const written = writeSettings(newer, { pitch: 1.8 })

    const raw = JSON.parse(written) as Record<string, unknown>
    expect(raw.marginDoodles).toBe('sunflowers')
    expect(raw.pitch).toBe(1.8)
    // And the value this version cannot use is still not offered to the page.
    expect(readSettings(written).pitch).toBe(1.8)
  })

  it('writes onto nothing, and onto a blob it could not parse', () => {
    expect(JSON.parse(writeSettings(null, { grainOn: false }))).toEqual({
      grainOn: false,
    })
    // A blob that will not parse cannot be merged into, and the alternative
    // to replacing it is refusing to save anything ever again.
    expect(JSON.parse(writeSettings('{oops', { grainOn: false }))).toEqual({
      grainOn: false,
    })
  })

  it('stores only what was set, so an untouched key follows the defaults', () => {
    const written = writeSettings(null, { face: 'serif' })
    expect(Object.keys(JSON.parse(written))).toEqual(['face'])
  })
})

describe('parseHex', () => {
  it('accepts the four forms and normalises them', () => {
    expect(parseHex('#a1b2c3')).toBe('#a1b2c3')
    expect(parseHex('a1b2c3')).toBe('#a1b2c3')
    expect(parseHex('#abc')).toBe('#aabbcc')
    expect(parseHex('abc')).toBe('#aabbcc')
    expect(parseHex('  #A1B2C3  ')).toBe('#a1b2c3')
  })

  it('refuses garbage rather than guessing at it', () => {
    for (const bad of ['', '#', 'ab', '#abcd', 'ghijkl', '#12345', 'red', '##abc']) {
      expect(parseHex(bad)).toBeNull()
    }
  })
})

describe('contrast', () => {
  it('measures the extremes', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 2)
  })

  // The warning's threshold, from both sides, because a boundary that is only
  // ever tested from one side is a boundary nobody checked.
  it('puts readable pairs above the threshold and faint ones below', () => {
    expect(contrast('#1a1917', '#faf6ef')).toBeGreaterThan(READABLE)
    expect(contrast('#777777', '#8a8a8a')).toBeLessThan(READABLE)
    // Order does not matter: it is a ratio between two colours, not of one
    // over the other.
    expect(contrast('#faf6ef', '#1a1917')).toBeCloseTo(
      contrast('#1a1917', '#faf6ef'),
      5,
    )
  })
})
