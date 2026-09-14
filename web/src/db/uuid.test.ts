import { afterEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from './uuid.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

// An hour ahead of the real clock, so no id minted by an earlier test is from
// a later millisecond than the one frozen here.
const later = () => Date.now() + 3_600_000

describe('uuidv7', () => {
  it('sorts ids minted in the same millisecond in creation order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(later())

    const ids = Array.from({ length: 1000 }, () => uuidv7())

    expect([...ids].sort()).toEqual(ids)
  })

  it('stays distinct, ordered and well-formed past the counter range of one millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(later())

    // 4096 counter values in a millisecond, so this runs past the end of it.
    const ids = Array.from({ length: 5000 }, () => uuidv7())

    expect(new Set(ids).size).toBe(5000)
    expect([...ids].sort()).toEqual(ids)
    const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(ids.every((id) => shape.test(id))).toBe(true)
  })

  it('sorts an id minted after the clock moves backwards after the one before it', () => {
    const base = later()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base)
    const before = uuidv7()

    clock.mockReturnValue(base - 60_000)
    const after = uuidv7()

    expect([after, before].sort()).toEqual([before, after])
  })

  it('sorts two ids a millisecond apart in creation order', async () => {
    const first = uuidv7()
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = uuidv7()

    expect([second, first].sort()).toEqual([first, second])
  })

  it('produces a thousand distinct values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()))

    expect(ids.size).toBe(1000)
  })

  it('sets the version and variant bits', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
