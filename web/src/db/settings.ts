// A collegebook's appearance. Per book and not per page: a notebook is ruled
// or plain, it is not ruled on page six, and fourteen pages would otherwise be
// fourteen places to set the same thing.
//
// Stored as the JSON text the server holds, rather than as a parsed object,
// for one reason: a blob written by a newer client carries keys this version
// has never heard of, and they have to survive being read and written here.
// Keeping the text is what makes that possible without knowing what they are.

export type Ruling = 'none' | 'ruled' | 'squared'
export type Face = 'sans' | 'serif' | 'mono'

export type BookSettings = {
  // 'none' is the ruling switched off: an on/off flag beside this would be a
  // second control for the bit this value already carries, and the two would
  // disagree the moment either was set alone.
  ruling: Ruling
  // Multiples of the body size, not pixels. The ruling never quite registers
  // with the text — a heading or a formula is taller than a line of prose —
  // and letting the reader tune it makes that a control rather than a defect.
  pitch: number
  ruleOn: boolean
  // Percent of the sheet's width.
  ruleInset: number
  pageNumbers: boolean
  // Lines, not pixels. "35 lines" is a thing a page can be; "560px" is not.
  pageLines: number
  paper: string
  ink: string
  grainOn: boolean
  grain: number
  // Multiples of the body size, for the reason pitch is.
  textSize: number
  face: Face
}

// What a book with no settings looks like, and therefore what every book
// looked like before this existed: these reproduce the page exactly. Reset
// clears the blob rather than writing these, so a later change here reaches
// books that were reset as well as books that were never touched.
export const DEFAULTS: BookSettings = {
  ruling: 'ruled',
  pitch: 1.6,
  ruleOn: true,
  ruleInset: 13,
  pageNumbers: true,
  pageLines: 35,
  paper: '#faf6ef',
  ink: '#1a1917',
  grainOn: true,
  grain: 0.25,
  textSize: 1,
  face: 'sans',
}

// WCAG 2.2 1.4.3 for body text. Not enforced anywhere — someone may want a
// faint watermark — but a user who cannot read their own notes should be told
// why rather than left to work it out.
export const READABLE = 4.5

export const PITCH = { min: 1.4, max: 2.4, step: 0.05 }
export const INSET = { min: 6, max: 24, step: 1 }
export const LINES = { min: 20, max: 60, step: 1 }
export const GRAIN = { min: 0.05, max: 0.6, step: 0.05 }
export const TEXT_SIZE = { min: 0.8, max: 1.6, step: 0.05 }

const RULINGS: Ruling[] = ['none', 'ruled', 'squared']
const FACES: Face[] = ['sans', 'serif', 'mono']

// `#rgb`, `rgb`, `#rrggbb`, `rrggbb`, in any case and with surrounding space.
// Null is "this is not a colour", and every caller leaves the colour alone on
// null rather than resetting it: a user halfway through typing `#ff` has not
// asked for anything yet.
export function parseHex(input: string): string | null {
  const body = input.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(body)) return null
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body
  return `#${full.toLowerCase()}`
}

// WCAG's relative luminance, and the ratio built from it. Written out rather
// than pulled in: it is nine lines and a dependency for nine lines is a
// dependency to keep in step forever.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

export function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (light! + 0.05) / (dark! + 0.05)
}

const bounded = (value: unknown, { min, max }: { min: number; max: number }) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined

const colour = (value: unknown) =>
  typeof value === 'string' ? (parseHex(value) ?? undefined) : undefined

const oneOf = <T extends string>(value: unknown, allowed: T[]) =>
  typeof value === 'string' && (allowed as string[]).includes(value)
    ? (value as T)
    : undefined

const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined)

// Every key falls back on its own. A value this version cannot use costs the
// user that one setting and not the eleven beside it, and a blob it cannot
// parse at all costs them nothing but their customisation — never the book.
export function readSettings(raw: string | null | undefined): BookSettings {
  const blob = decode(raw)
  return {
    ruling: oneOf(blob.ruling, RULINGS) ?? DEFAULTS.ruling,
    pitch: bounded(blob.pitch, PITCH) ?? DEFAULTS.pitch,
    ruleOn: flag(blob.ruleOn) ?? DEFAULTS.ruleOn,
    ruleInset: bounded(blob.ruleInset, INSET) ?? DEFAULTS.ruleInset,
    pageNumbers: flag(blob.pageNumbers) ?? DEFAULTS.pageNumbers,
    pageLines: bounded(blob.pageLines, LINES) ?? DEFAULTS.pageLines,
    paper: colour(blob.paper) ?? DEFAULTS.paper,
    ink: colour(blob.ink) ?? DEFAULTS.ink,
    grainOn: flag(blob.grainOn) ?? DEFAULTS.grainOn,
    grain: bounded(blob.grain, GRAIN) ?? DEFAULTS.grain,
    textSize: bounded(blob.textSize, TEXT_SIZE) ?? DEFAULTS.textSize,
    face: oneOf(blob.face, FACES) ?? DEFAULTS.face,
  }
}

// Merged onto whatever is already stored, so keys this version does not know
// are carried through untouched. A parse-and-reserialise of the twelve fields
// above would satisfy every other test in this file and quietly drop a newer
// client's settings, which is the failure worth guarding.
export function writeSettings(
  raw: string | null | undefined,
  patch: Partial<BookSettings>,
): string {
  return JSON.stringify({ ...decode(raw), ...patch })
}

function decode(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    // Arrays and null are objects to typeof, and neither is a settings blob.
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
