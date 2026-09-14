import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import CSS from '../../index.css?raw'
import { DEFAULTS, type BookSettings as Settings } from '../../db/settings.ts'
import i18n from '../../i18n/index.ts'
import BookSettings from './BookSettings.tsx'

// The labels below are the English ones, so the language is pinned rather
// than left to whatever navigator.language says under the runner.
beforeAll(async () => {
  await i18n.changeLanguage('en')
})

afterEach(cleanup)

const show = (over: Partial<Settings> = {}) => {
  const onChange = vi.fn()
  const onReset = vi.fn()
  const view = render(
    <BookSettings
      settings={{ ...DEFAULTS, ...over }}
      onChange={onChange}
      onReset={onReset}
    />,
  )
  return { ...view, onChange, onReset }
}

const open = (over: Partial<Settings> = {}) => {
  const view = show(over)
  fireEvent.click(screen.getByRole('button', { name: 'Page appearance' }))
  return { ...view, panel: screen.getByRole('dialog') }
}

describe('the settings panel', () => {
  it('opens from the gear and closes on Escape and on an outside click', () => {
    show()
    expect(screen.queryByRole('dialog')).toBeNull()

    const gear = screen.getByRole('button', { name: 'Page appearance' })
    fireEvent.click(gear)
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(gear.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(gear)
    expect(screen.getByRole('dialog')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // Every control reports the change as it moves. There is no apply button
  // and there is deliberately nowhere for a pending value to sit.
  it('reports a change from each kind of control as it moves', () => {
    const { onChange, panel } = open()

    fireEvent.change(within(panel).getByLabelText('Line pitch'), {
      target: { value: '2.1' },
    })
    expect(onChange).toHaveBeenCalledWith({ pitch: 2.1 })

    fireEvent.click(within(panel).getByRole('radio', { name: 'Squared' }))
    expect(onChange).toHaveBeenCalledWith({ ruling: 'squared' })

    fireEvent.click(within(panel).getByLabelText('Margin rule'))
    expect(onChange).toHaveBeenCalledWith({ ruleOn: false })

    fireEvent.change(within(panel).getByLabelText('Page height'), {
      target: { value: '42' },
    })
    expect(onChange).toHaveBeenCalledWith({ pageLines: 42 })

    fireEvent.change(within(panel).getByLabelText('Font'), {
      target: { value: 'serif' },
    })
    expect(onChange).toHaveBeenCalledWith({ face: 'serif' })
  })

  it('takes a colour from a swatch, a hex field and the native picker', () => {
    const { onChange, panel } = open()

    const paper = within(panel).getByRole('group', { name: 'Paper' })
    fireEvent.click(within(paper).getAllByRole('button')[2]!)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ paper: expect.stringMatching(/^#[0-9a-f]{6}$/) }),
    )

    fireEvent.change(within(paper).getByLabelText('Paper hex'), {
      target: { value: '#abc' },
    })
    expect(onChange).toHaveBeenCalledWith({ paper: '#aabbcc' })

    fireEvent.change(within(paper).getByLabelText('Paper swatch'), {
      target: { value: '#123456' },
    })
    expect(onChange).toHaveBeenCalledWith({ paper: '#123456' })
  })

  // Half-typed input is not a request to change anything, and a field that
  // reset the colour on every unfinished keystroke would be unusable.
  it('leaves the colour alone while the hex field holds something invalid', () => {
    const { onChange, panel } = open()
    const field = within(panel).getByLabelText('Text hex')

    fireEvent.change(field, { target: { value: '#ff' } })
    fireEvent.change(field, { target: { value: 'nonsense' } })
    expect(onChange).not.toHaveBeenCalled()
    // The typing is still in the field: it is not snapped back under the hand.
    expect((field as HTMLInputElement).value).toBe('nonsense')

    fireEvent.change(field, { target: { value: '#ff0000' } })
    expect(onChange).toHaveBeenCalledWith({ ink: '#ff0000' })
  })

  it('warns below the readable ratio and says nothing above it', () => {
    const { panel } = open({ paper: '#faf6ef', ink: '#1a1917' })
    expect(within(panel).queryByRole('status')).toBeNull()
    cleanup()

    const faint = open({ paper: '#8a8a8a', ink: '#777777' })
    expect(within(faint.panel).getByRole('status').textContent).toContain(
      'hard to read',
    )
  })

  // Not a block: someone may want a faint watermark. The warning says so and
  // the controls keep working.
  it('does not disable anything when it warns', () => {
    const { panel, onChange } = open({ paper: '#8a8a8a', ink: '#777777' })
    fireEvent.change(within(panel).getByLabelText('Text hex'), {
      target: { value: '#787878' },
    })
    expect(onChange).toHaveBeenCalledWith({ ink: '#787878' })
  })

  it('asks before resetting, and does nothing when the answer is no', () => {
    const { panel, onReset } = open()
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false)

    fireEvent.click(within(panel).getByRole('button', { name: 'Reset to defaults' }))
    expect(ask).toHaveBeenCalled()
    expect(onReset).not.toHaveBeenCalled()

    ask.mockReturnValue(true)
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset to defaults' }))
    expect(onReset).toHaveBeenCalledTimes(1)
    ask.mockRestore()
  })
})

// Structural only, and this block asserts nothing about appearance: jsdom has
// no layout engine and resolves no custom property, so nothing here can say
// what colour a segment is, how tall a row comes out, whether the Slovak fits
// the label column, or whether the gear is where it should be. What a test can
// hold is that restyling did not quietly turn a control into a div.
describe('the panel after restyling', () => {
  it('keeps every control a real control, still labelled', () => {
    const { panel } = open()

    // A segmented control that stopped being radios would lose the arrow keys
    // and the group with them, and would look exactly the same.
    const segments = within(panel).getAllByRole('radio')
    expect(segments).toHaveLength(3)
    for (const segment of segments) {
      expect(segment.tagName).toBe('INPUT')
      expect(segment.getAttribute('type')).toBe('radio')
    }
    expect(
      within(panel).getByRole('radiogroup', { name: 'Ruling' }),
    ).not.toBeNull()

    const named = (label: string) => within(panel).getByLabelText(label)
    for (const [label, type] of [
      ['Line pitch', 'range'],
      ['Inset', 'range'],
      ['Page height', 'range'],
      ['Grain strength', 'range'],
      ['Text size', 'range'],
      ['Margin rule', 'checkbox'],
      ['Page numbers', 'checkbox'],
      ['Grain', 'checkbox'],
      ['Paper hex', 'text'],
      ['Text hex', 'text'],
      ['Paper swatch', 'color'],
      ['Text swatch', 'color'],
    ] as const) {
      const control = named(label)
      expect(control.tagName).toBe('INPUT')
      expect(control.getAttribute('type')).toBe(type)
    }

    // appearance: none does not make a select something else.
    const face = named('Font')
    expect(face.tagName).toBe('SELECT')
    expect(within(face as HTMLSelectElement).getAllByRole('option')).toHaveLength(3)

    expect(
      within(panel).getByRole('button', { name: 'Reset to defaults' }).tagName,
    ).toBe('BUTTON')
  })

  it('leaves the gear a button in the tab order while it is invisible', () => {
    show()
    const gear = screen.getByRole('button', { name: 'Page appearance' })
    // Hidden by opacity, which keeps it focusable. display: none or
    // visibility: hidden would take it out of the tab order and the
    // accessibility tree, and the only way back to it would be a mouse.
    expect(gear.tagName).toBe('BUTTON')
    expect(gear.getAttribute('hidden')).toBeNull()
    expect(gear.getAttribute('aria-hidden')).toBeNull()
  })

  // The non-negotiable, checked the only way it can be without layout: the
  // panel's rules are read out of the stylesheet and none of them may mention
  // the two properties a book's settings write. A reader who sets black paper
  // and black ink must still be able to find the reset button.
  it('takes none of its colours from the book', () => {
    // Comments out first. Without this a rule's "selector" is whatever
    // comment precedes it, the filter below matches almost none of them, and
    // the whole check passes by reading four rules out of forty.
    const source = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const blocks = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    const mine = blocks.filter(([, selector]) =>
      /(^|,)\s*\.(set-|book-settings|book-gear|gear\b)/.test(selector ?? ''),
    )
    // If this ever matches nothing the test is passing vacuously.
    expect(mine.length).toBeGreaterThan(10)
    for (const block of mine) {
      const selector = (block[1] ?? '').trim()
      const uses = /var\(--(paper|ink)\b/.exec(block[2] ?? '')?.[0] ?? null
      expect({ selector, uses }).toEqual({ selector, uses: null })
    }

    // And the panel states its own ground, text, face and size rather than
    // inheriting whatever it sits on. Read from the source, not from
    // getComputedStyle: jsdom does not resolve a custom property inside a
    // shorthand and hands back a transparent black for all of them.
    const panelBlock = mine.find(
      ([, selector]) => (selector ?? '').trim() === '.book-settings',
    )
    expect(panelBlock).toBeDefined()
    for (const declaration of [
      'background: var(--card)',
      'color: var(--text)',
      'font-family: system-ui',
      'font-size: var(--body)',
    ]) {
      expect(panelBlock?.[2] ?? '').toContain(declaration)
    }
  })
})
