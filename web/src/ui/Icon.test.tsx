import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Icon, { type IconName } from './Icon.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const shapes = (container: HTMLElement, tag: string) =>
  [...container.querySelectorAll(tag)].map((node) => node.getAttribute('d'))

describe('Icon', () => {
  it('renders the vendored path data for a name', () => {
    const { container } = render(<Icon name="graduation-cap" />)

    expect(shapes(container, 'path')).toEqual([
      'M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z',
      'M22 10v6',
      'M6 12.5V16a6 3 0 0 0 12 0v-3.5',
    ])
  })

  // sun and archive are not path-only, and a map that held nothing but `d`
  // strings would silently drop their circle and rect.
  it('renders the shapes that are not paths', () => {
    const { container } = render(<Icon name="sun" />)
    expect(container.querySelector('circle')?.getAttribute('r')).toBe('4')

    const archive = render(<Icon name="archive" />)
    expect(archive.container.querySelector('rect')?.getAttribute('x')).toBe('2')
  })

  it('renders nothing for an unknown name', () => {
    const { container } = render(<Icon name={'no-such-icon' as IconName} />)

    expect(container.querySelector('svg')).toBeNull()
  })

  it('is decorative, and 16 unless told otherwise', () => {
    const { container } = render(<Icon name="inbox" className="rail-icon" />)
    const svg = container.querySelector('svg')!

    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.getAttribute('class')).toBe('rail-icon')
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')

    const big = render(<Icon name="inbox" size={24} />)
    expect(big.container.querySelector('svg')?.getAttribute('height')).toBe('24')
  })
})
