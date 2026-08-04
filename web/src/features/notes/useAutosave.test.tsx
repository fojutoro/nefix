import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveTitle, useAutosave, type SaveNote } from './useAutosave.ts'

const UNTITLED = 'Untitled'

describe('useAutosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = () => {
    const save = vi.fn<SaveNote>(() => Promise.resolve())
    const view = renderHook(() => useAutosave('note-1', UNTITLED, save))
    return { save, view }
  }

  it('collapses three rapid changes into one write', () => {
    const { save, view } = setup()

    act(() => {
      view.result.current('a')
      vi.advanceTimersByTime(100)
      view.result.current('ab')
      vi.advanceTimersByTime(100)
      view.result.current('abc')
    })
    expect(save).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(500))

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('note-1', {
      bodyMd: 'abc',
      title: 'abc',
    })
  })

  it('writes once per pause over ten seconds of typing, not once per key', () => {
    const { save, view } = setup()
    let typed = ''

    // Five bursts of twenty keystrokes at 80ms, each followed by a pause
    // long enough for the debounce to expire. 100 keystrokes, 5 pauses.
    act(() => {
      for (let burst = 0; burst < 5; burst++) {
        for (let key = 0; key < 20; key++) {
          typed += 'x'
          view.result.current(typed)
          vi.advanceTimersByTime(80)
        }
        vi.advanceTimersByTime(600)
      }
    })

    expect(save).toHaveBeenCalledTimes(5)
  })

  it('flushes a pending change on unmount', () => {
    const { save, view } = setup()

    act(() => {
      view.result.current('unsaved')
      vi.advanceTimersByTime(100)
    })
    expect(save).not.toHaveBeenCalled()

    act(() => view.unmount())

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('note-1', {
      bodyMd: 'unsaved',
      title: 'unsaved',
    })

    // The cancelled timer must not fire a second write afterwards.
    act(() => vi.advanceTimersByTime(500))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flushes on visibilitychange to hidden', () => {
    const { save, view } = setup()

    act(() => view.result.current('typed'))
    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flushes on pagehide', () => {
    const { save, view } = setup()

    act(() => view.result.current('typed'))
    act(() => void window.dispatchEvent(new Event('pagehide')))

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('writes a pending change against the note it was typed into', () => {
    const save = vi.fn<SaveNote>(() => Promise.resolve())
    const view = renderHook(
      ({ id }) => useAutosave(id, UNTITLED, save),
      { initialProps: { id: 'note-1' } },
    )

    act(() => view.result.current('belongs to one'))
    act(() => view.rerender({ id: 'note-2' }))

    expect(save).toHaveBeenCalledWith('note-1', {
      bodyMd: 'belongs to one',
      title: 'belongs to one',
    })
  })
})

describe('deriveTitle', () => {
  const cases: [string, string, string][] = [
    ['a plain first line', 'Lecture on graphs\nsecond line', 'Lecture on graphs'],
    ['a # heading', '# Heading\nbody', 'Heading'],
    ['a ###  spaced heading', '###  spaced\nbody', 'spaced'],
    ['an empty body', '', UNTITLED],
    ['a body of only whitespace', '   \n\t\n', UNTITLED],
    ['a body starting with a blank line', '\n\nReal title\nbody', 'Real title'],
    ['a Slovak line with diacritics', '# Šialené výsledky merania', 'Šialené výsledky merania'],
  ]

  for (const [name, body, expected] of cases) {
    it(`handles ${name}`, () => {
      expect(deriveTitle(body, UNTITLED)).toBe(expected)
    })
  }

  it('caps a first line longer than 200 characters', () => {
    const title = deriveTitle('x'.repeat(250), UNTITLED)

    expect(title).toHaveLength(200)
    expect(title).toBe('x'.repeat(200))
  })
})
