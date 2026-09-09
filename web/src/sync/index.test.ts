import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNote } from '../db/notes.ts'
import { db } from '../db/schema.ts'
import i18n from '../i18n/index.ts'
import { sync } from './index.ts'
import { syncState } from './state.ts'

// Every request's path, in the order it was made. Asserting that both
// happened would pass on the ordering this module exists to prevent.
function record(): string[] {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { body?: string }) => {
      calls.push(new URL(url, 'http://localhost').pathname)
      const body =
        init?.body === undefined
          ? { notes: [], cursor: 0, has_more: false }
          : {
              results: (
                JSON.parse(init.body) as { notes: { id: string }[] }
              ).notes.map((note) => ({
                id: note.id,
                status: 'accepted',
                note: {
                  ...note,
                  version: 1,
                  seq: 1,
                  created_at: '2026-08-05T09:30:00.000Z',
                  updated_at: '2026-08-05T11:02:00.000Z',
                },
              })),
            }
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
    }),
  )
  return calls
}

beforeEach(async () => {
  await db.notes.clear()
  await db.meta.clear()
  await i18n.changeLanguage('en')
  syncState.setState({
    status: 'idle',
    lastSummary: null,
    lastPull: null,
    lastSyncedAt: null,
    lastError: null,
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('sync', () => {
  it('pushes before it pulls', async () => {
    await createNote({ title: 'algebra' })
    const calls = record()

    await sync()

    expect(calls).toEqual(['/api/v1/sync/push', '/api/v1/sync/pull'])
  })

  it('makes no pull request when the push could not reach the server', async () => {
    await createNote({ title: 'algebra' })
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(new URL(url, 'http://localhost').pathname)
        return Promise.reject(new TypeError('Failed to fetch'))
      }),
    )

    const summary = await sync()

    expect(calls).toEqual(['/api/v1/sync/push'])
    expect(summary.pull).toMatchObject({ applied: 0, pages: 0 })
    expect(syncState.current.status).toBe('offline')
  })

  it('runs one cycle when two overlap', async () => {
    await createNote({ title: 'algebra' })
    const calls = record()

    await Promise.all([sync(), sync()])

    expect(calls).toEqual(['/api/v1/sync/push', '/api/v1/sync/pull'])
  })
})
