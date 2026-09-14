import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClass } from '../../db/classes.ts'
import { createCollegebook } from '../../db/notebooks.ts'
import { db } from '../../db/schema.ts'
import i18n from '../../i18n/index.ts'
import type { SyncStateValue } from '../../sync/state.ts'
import { DEBOUNCE_MS } from './format.ts'
import SyncDot from './SyncDot.tsx'

const account = {
  id: 1,
  username: 'jozef',
  display_name: 'Jozef Novák',
  email: 'jozef@example.sk',
  role: 'student' as const,
}

const state = (over: Partial<SyncStateValue> = {}): SyncStateValue => ({
  status: 'idle',
  lastSummary: null,
  lastPull: null,
  lastSyncedAt: null,
  lastError: null,
  ...over,
})

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

beforeEach(async () => {
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
  await db.meta.clear()
})

afterEach(cleanup)

type Props = Parameters<typeof SyncDot>[0]

const show = (props: Partial<Props> = {}) => {
  const onSignOut = vi.fn()
  const view = render(
    <SyncDot
      account={account}
      sync={state()}
      online={true}
      pending={0}
      onSignOut={onSignOut}
      {...props}
    />,
  )
  return { ...view, onSignOut }
}

const dot = () => screen.getByRole('button', { name: /^Sync/ })

describe('the dot', () => {
  // Colour alone is not a signal for everyone, so the state is in the name
  // whatever the fill is.
  it('carries the state in words, and a colour for each', () => {
    const cases: [Partial<Props>, string, string][] = [
      [{}, 'green', 'Sync: up to date'],
      [{ pending: 3 }, 'yellow', 'Sync: 3 changes waiting'],
      [{ sync: state({ status: 'syncing' }) }, 'yellow', 'Sync: syncing'],
      [{ online: false }, 'red', 'Sync: offline'],
      [{ sync: state({ status: 'error' }) }, 'red', 'Sync: failed'],
      [{ sync: state({ status: 'unauthenticated' }) }, 'red', 'Sync: signed out'],
    ]
    for (const [props, colour, name] of cases) {
      show(props)
      const button = screen.getByRole('button', { name })
      expect(button.getAttribute('data-state')).toBe(colour)
      cleanup()
    }
  })

  // A two-second cycle must not make it blink. The dot is in the corner of
  // the eye of someone writing.
  it('does not change more than once inside the debounce window', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(
        <SyncDot account={account} sync={state()} online pending={0} onSignOut={vi.fn()} />,
      )
      expect(dot().getAttribute('data-state')).toBe('green')

      rerender(
        <SyncDot account={account} sync={state({ status: 'syncing' })} online pending={0} onSignOut={vi.fn()} />,
      )
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS / 4))
      expect(dot().getAttribute('data-state')).toBe('green')

      rerender(
        <SyncDot account={account} sync={state()} online pending={0} onSignOut={vi.fn()} />,
      )
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS * 2))
      // Never yellow: the blip was shorter than the window, so the dot never
      // moved at all.
      expect(dot().getAttribute('data-state')).toBe('green')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does show a state that outlasts the window', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(
        <SyncDot account={account} sync={state()} online pending={0} onSignOut={vi.fn()} />,
      )
      rerender(
        <SyncDot account={account} sync={state({ status: 'error' })} online pending={0} onSignOut={vi.fn()} />,
      )
      act(() => vi.advanceTimersByTime(DEBOUNCE_MS * 2))
      expect(dot().getAttribute('data-state')).toBe('red')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the account panel', () => {
  it('opens from the dot and closes on Escape and outside click', () => {
    show()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(dot())
    expect(screen.getByRole('dialog')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(dot())
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows who is signed in, the state in words and what is waiting', () => {
    show({ pending: 2, sync: state({ lastSyncedAt: Date.now() - 60_000 }) })
    fireEvent.click(dot())
    const panel = screen.getByRole('dialog')

    expect(panel.textContent).toContain('Jozef Novák')
    expect(panel.textContent).toContain('jozef')
    expect(panel.textContent).toContain('jozef@example.sk')
    // The same words the dot uses, so the panel explains the colour.
    expect(panel.textContent).toContain('2 changes waiting')
    expect(within(panel).getByRole('button', { name: 'Sign out' })).not.toBeNull()
    expect(within(panel).getByRole('button', { name: 'Switch to Slovak' })).not.toBeNull()
  })

  it('says nothing about waiting changes when there are none', () => {
    show({ pending: 0 })
    fireEvent.click(dot())
    expect(screen.getByRole('dialog').textContent).not.toContain('waiting')
  })

  it('signs out through the panel', () => {
    const { onSignOut } = show()
    fireEvent.click(dot())
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('opens the debug panel from the alert icon, and its counts match Dexie', async () => {
    await db.meta.put({ key: 'syncCursor', value: 17 })
    const cls = await createClass({ name: 'Diskrétna matematika' })
    await createCollegebook('Prednášky', cls.id)
    await db.classes.update(cls.id, { dirty: false })
    show()
    fireEvent.click(dot())
    fireEvent.click(screen.getByRole('button', { name: 'Sync diagnostics' }))

    const panels = await screen.findAllByRole('dialog')
    const debug = panels[panels.length - 1]!
    await waitFor(() => expect(debug.textContent).toContain('17'))
    expect(debug.textContent).toContain(String(db.verno))

    // Read off the panel and compared with the tables themselves, so the row
    // is wrong if either the query or the rendering drifts.
    const row = (name: string) =>
      within(debug)
        .getByRole('row', { name: new RegExp(`^${name}`) })
        .querySelectorAll('td')
    const cells = (name: string) =>
      [...row(name)].map((cell) => Number(cell.textContent))

    expect(cells('Classes')).toEqual([
      await db.classes.count(),
      await db.classes.filter((r) => r.dirty).count(),
    ])
    // The book and the general notebook its class was created with, both
    // still waiting.
    expect(cells('Notebooks')).toEqual([2, 2])
    expect(cells('Notes')).toEqual([
      await db.notes.count(),
      await db.notes.filter((r) => r.dirty).count(),
    ])
  })
})
