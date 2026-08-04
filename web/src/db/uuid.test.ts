import { describe, expect, it } from 'vitest'
import { uuidv7 } from './uuid.ts'

describe('uuidv7', () => {
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
