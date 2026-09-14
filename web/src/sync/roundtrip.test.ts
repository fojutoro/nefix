import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollegebook, updateBookSettings } from '../db/notebooks.ts'
import { db } from '../db/schema.ts'
import { readSettings } from '../db/settings.ts'
import type { PushNotebook, PushRequest, PushResult, WireNotebook } from './api.ts'
import { pullRemoteChanges } from './pull.ts'
import { pushDirtyRows } from './push.ts'

const CSRF_FIXTURE = 'nefix_csrf=Zm9yLXRlc3Rz'

// A stand-in server that holds only what a client actually put on the wire.
// That is the whole point of it: the store tests and the wire-shape tests each
// pass with a field the mapper between them drops, because neither of them
// ever carries a value across the gap. This does, so a field missing from
// toWireNotebook is a row the server never had, and a field missing from
// fromWireNotebook is a row the second client never reads.
function server() {
  const rows = new Map<string, WireNotebook>()
  let seq = 0

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = (json: unknown) => ({ ok: true, status: 200, json: async () => json })

      if (url.includes('/sync/push')) {
        const sent = JSON.parse(init!.body!) as PushRequest
        const results: PushResult[] = sent.notebooks.map((row: PushNotebook) => {
          seq += 1
          // Everything the server assigns, and nothing else touched: the row
          // it stores is the row it was sent.
          const saved: WireNotebook = {
            ...row,
            version: row.version + 1,
            seq,
            created_at: '2026-09-01T10:00:00.000Z',
            updated_at: '2026-09-01T10:00:00.000Z',
          }
          rows.set(row.id, saved)
          return { id: row.id, kind: 'notebook', status: 'accepted', notebook: saved }
        })
        return body({ results })
      }

      const since = Number(new URL(url, 'http://x').searchParams.get('since') ?? 0)
      const notebooks = [...rows.values()].filter((row) => row.seq > since)
      const cursor = notebooks.reduce((high, row) => Math.max(high, row.seq), since)
      return body({ classes: [], notebooks, notes: [], cursor, has_more: false })
    }),
  )

  return rows
}

// The second device: the same code against an empty database and a cursor of
// zero, which is exactly what a fresh install is.
async function asSecondDevice<T>(run: () => Promise<T>): Promise<T> {
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
  await db.meta.clear()
  return run()
}

beforeEach(async () => {
  document.cookie = CSRF_FIXTURE
  await db.notes.clear()
  await db.classes.clear()
  await db.notebooks.clear()
  await db.meta.clear()
})

describe('a collegebook appearance, device to device', () => {
  it('reaches a second client through a push and a pull', async () => {
    const stored = server()

    // Device one: the reader sets two things, one of them a colour.
    const book = await createCollegebook('Prednášky', null)
    await updateBookSettings(book.id, { ruling: 'squared' })
    await updateBookSettings(book.id, { paper: '#1c2733' })
    await pushDirtyRows()

    // It reached the server as text, not as a re-encoded object.
    expect(stored.get(book.id)?.settings).toBe(
      '{"ruling":"squared","paper":"#1c2733"}',
    )

    // Device two, which has never seen this book.
    await asSecondDevice(async () => {
      await pullRemoteChanges()

      const arrived = await db.notebooks.get(book.id)
      expect(arrived).toBeDefined()
      expect(arrived?.settings).toBe('{"ruling":"squared","paper":"#1c2733"}')
      // And read as settings, which is what the page is drawn from.
      const settings = readSettings(arrived?.settings ?? null)
      expect(settings.ruling).toBe('squared')
      expect(settings.paper).toBe('#1c2733')
    })
  })

  it('carries a key the sending client never knew about', async () => {
    const stored = server()
    const book = await createCollegebook('Prednášky', null)
    // As if a newer client had written it here first.
    await db.notebooks.update(book.id, {
      settings: '{"ruling":"squared","marginDoodles":"sunflowers"}',
      dirty: true,
    })
    await pushDirtyRows()

    expect(stored.get(book.id)?.settings).toContain('marginDoodles')

    await asSecondDevice(async () => {
      await pullRemoteChanges()
      expect((await db.notebooks.get(book.id))?.settings).toBe(
        '{"ruling":"squared","marginDoodles":"sunflowers"}',
      )
    })
  })

  it('carries a reset, so the second device goes back to the defaults too', async () => {
    const stored = server()
    const book = await createCollegebook('Prednášky', null)
    await updateBookSettings(book.id, { ruling: 'squared' })
    await pushDirtyRows()

    await db.notebooks.update(book.id, { settings: null, dirty: true })
    await pushDirtyRows()
    expect(stored.get(book.id)?.settings).toBeNull()

    await asSecondDevice(async () => {
      await pullRemoteChanges()
      expect((await db.notebooks.get(book.id))?.settings).toBeNull()
    })
  })
})
