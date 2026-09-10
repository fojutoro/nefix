import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Note } from '../../db/schema.ts'
import i18n from '../../i18n/index.ts'
import ActivityStrip from './ActivityStrip.tsx'

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => {
  document.body.innerHTML = ''
})

// Only the fields the strip reads. A whole Note would say that the strip
// depends on more of one than it does.
const at = (iso: string) => ({ updatedAt: iso }) as Note

// Mondays, so the fixture says which cell it means without depending on how
// the component rounds. 2 February 2026 is a Monday.
const week = (n: number, day = 0) =>
  at(new Date(2026, 1, 2 + (n - 1) * 7 + day).toISOString())

// The weight is the mark's darkness, 0 for a week with nothing in it.
const weights = () =>
  screen
    .getAllByRole('listitem')
    .map((cell) => Number(cell.getAttribute('data-weight')))

const filled = () => weights().map((weight) => weight > 0)

describe('ActivityStrip', () => {
  it('draws fourteen cells and fills only the weeks that were written in', () => {
    // Weeks 1, 3 and 8. Neither "every cell filled" nor "the first three
    // cells filled" can produce this, which is the point of the gaps.
    render(
      <ActivityStrip notes={[week(1), week(3, 2), week(8), week(8, 4)]} />,
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(14)
    expect(filled()).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
  })

  it('counts week one from the Monday of the earliest note, not from the note', () => {
    // Written on the Friday. The week it belongs to started on the Monday, so
    // a note on the Monday before it lands in the same cell, not an earlier
    // one. Weeks 6 and 9 are there to clear the three-week floor.
    render(<ActivityStrip notes={[week(1, 4), week(1), week(6), week(9)]} />)

    expect(filled()[0]).toBe(true)
    // Three, not four: the Friday note and the Monday note are one week.
    expect(filled().filter(Boolean)).toHaveLength(3)
  })

  it('names the date range and the count of each cell', () => {
    render(<ActivityStrip notes={[week(1), week(1, 1), week(6), week(9)]} />)

    const [first] = screen.getAllByRole('listitem')
    // Matched rather than compared: Intl puts thin spaces around the dash,
    // and a test carrying invisible characters is a test nobody can edit.
    expect(first!.getAttribute('title')).toMatch(/^Feb 2\s*–\s*8 · 2 notes$/)
  })

  it('renders nothing at all for a class with no notes', () => {
    const { container } = render(<ActivityStrip notes={[]} />)

    expect(container.firstChild).toBeNull()
  })

  it('ignores notes past the fourteenth week rather than stretching to them', () => {
    render(
      <ActivityStrip notes={[week(1), week(6), week(9), week(20), week(30)]} />,
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(14)
    // The two out past the window light nothing. A semester is fourteen weeks
    // and this one has run over.
    expect(filled().filter(Boolean)).toHaveLength(3)
  })

  it('is absent below three filled weeks and present at three', () => {
    // One crimson mark among thirteen blanks looks like an error, and a class
    // two weeks old has nothing to say yet.
    const { container, rerender } = render(
      <ActivityStrip notes={[week(1), week(1, 2), week(4)]} />,
    )
    expect(container.firstChild).toBeNull()

    rerender(<ActivityStrip notes={[week(1), week(4), week(7)]} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(14)
  })

  it('weights a mark by how much was written that week', () => {
    render(
      <ActivityStrip
        notes={[
          week(1),
          week(3),
          week(3, 1),
          week(5),
          week(5, 1),
          week(5, 2),
          ...Array.from({ length: 6 }, (_, day) => week(7, day)),
        ]}
      />,
    )

    // One note is faint, five or more is full, so a glance shows how much and
    // not only whether.
    const [one, , two, , three, , six] = weights()
    expect(one).toBe(1)
    expect(two).toBe(2)
    expect(three).toBe(3)
    expect(six).toBe(4)
    // And a week with nothing in it carries no weight at all.
    expect(weights()[1]).toBe(0)
  })

  it('scales the strip in months, which is a thing a student feels', () => {
    render(<ActivityStrip notes={[week(1), week(6), week(9)]} />)

    // Fourteen weeks from 2 February 2026 ends in May.
    expect(screen.getByText('Feb')).toBeDefined()
    expect(screen.getByText('May')).toBeDefined()
  })
})
