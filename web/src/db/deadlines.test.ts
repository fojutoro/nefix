import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDeadline,
  deleteDeadline,
  listDeadlines,
  listOverdue,
  listUpcoming,
  toggleDone,
  updateDeadline,
} from './deadlines.ts'
import { db } from './schema.ts'

// Midnight UTC, which is how every dueAt is stored: the date is the value and
// the time component means nothing.
const day = (date: string) => `${date}T00:00:00.000Z`

// N days from the reader's today, as a stored dueAt.
function daysAway(offset: number): string {
  const now = new Date()
  const shifted = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const month = String(shifted.getMonth() + 1).padStart(2, '0')
  const date = String(shifted.getDate()).padStart(2, '0')
  return day(`${shifted.getFullYear()}-${month}-${date}`)
}

beforeEach(async () => {
  await db.deadlines.clear()
  await db.notes.clear()
  await db.notebooks.clear()
  await db.classes.clear()
})

describe('createDeadline', () => {
  it('defaults the optional half and starts dirty and outstanding', async () => {
    const created = await createDeadline({
      title: 'Písomka',
      dueAt: daysAway(3),
    })

    expect(created.kind).toBe('other')
    expect(created.classId).toBeNull()
    expect(created.note).toBeNull()
    expect(created.topics).toEqual([])
    expect(created.doneAt).toBeNull()
    expect(created.deletedAt).toBeNull()
    // Version 0 is a row the server has never had, and dirty is what puts it
    // in the push queue. A create that forgot it would never sync and would
    // give no sign of it.
    expect(created.version).toBe(0)
    expect(created.dirty).toBe(true)
    expect(created.syncedAt).toBeNull()
  })

  it('keeps the topics it was given, as objects', async () => {
    const created = await createDeadline({
      title: 'Písomka',
      dueAt: daysAway(1),
      kind: 'test',
      classId: 'c1',
      note: 'prines kalkulačku',
      topics: [{ noteId: 'n1', heading: 'Množiny' }],
    })

    const stored = await db.deadlines.get(created.id)
    // Parsed, not text: the client is what understands a topic, so this layer
    // holds objects and only the wire boundary sees JSON.
    expect(stored?.topics).toEqual([{ noteId: 'n1', heading: 'Množiny' }])
    expect(stored?.kind).toBe('test')
    expect(stored?.note).toBe('prines kalkulačku')
  })
})

describe('updateDeadline', () => {
  it('changes only what the patch names and re-dirties the row', async () => {
    const created = await createDeadline({
      title: 'Písomka',
      dueAt: daysAway(3),
      kind: 'test',
      note: 'prines kalkulačku',
    })
    await db.deadlines.update(created.id, { dirty: false, version: 4 })

    await updateDeadline(created.id, { dueAt: daysAway(9) })

    const stored = await db.deadlines.get(created.id)
    expect(stored?.dueAt).toBe(daysAway(9))
    // Untouched, because the patch did not mention them. Spreading the patch
    // would have written undefined over both.
    expect(stored?.title).toBe('Písomka')
    expect(stored?.note).toBe('prines kalkulačku')
    expect(stored?.kind).toBe('test')
    expect(stored?.dirty).toBe(true)
    expect(stored?.version).toBe(4)
  })

  it('refuses a deadline that is not there', async () => {
    await expect(updateDeadline('nope', { title: 'x' })).rejects.toThrow('not found')
  })
})

describe('toggleDone', () => {
  it('ticks off and un-ticks, and dirties the row both ways', async () => {
    const created = await createDeadline({ title: 'Písomka', dueAt: daysAway(2) })
    await db.deadlines.update(created.id, { dirty: false })

    await toggleDone(created.id)
    const done = await db.deadlines.get(created.id)
    expect(done?.doneAt).not.toBeNull()
    expect(done?.dirty).toBe(true)
    // Ticking off is not deleting: the row stays and still syncs.
    expect(done?.deletedAt).toBeNull()

    await db.deadlines.update(created.id, { dirty: false })
    await toggleDone(created.id)
    const back = await db.deadlines.get(created.id)
    expect(back?.doneAt).toBeNull()
    expect(back?.dirty).toBe(true)
  })
})

describe('deleteDeadline', () => {
  it('soft-deletes and hides the row from every listing', async () => {
    const created = await createDeadline({ title: 'Písomka', dueAt: daysAway(2) })

    await deleteDeadline(created.id)

    const stored = await db.deadlines.get(created.id)
    expect(stored?.deletedAt).not.toBeNull()
    // A hard delete would leave sync unable to tell "deleted" from "never
    // existed", so the row has to stay and be marked.
    expect(stored?.dirty).toBe(true)
    expect(await listDeadlines()).toHaveLength(0)
    expect(await listUpcoming(10)).toHaveLength(0)
  })
})

describe('listDeadlines', () => {
  it('follows the undefined, string and null convention', async () => {
    await createDeadline({ title: 'Loose', dueAt: daysAway(1) })
    await createDeadline({ title: 'Diskrétna', dueAt: daysAway(2), classId: 'c1' })
    await createDeadline({ title: 'Algebra', dueAt: daysAway(3), classId: 'c2' })

    expect(await listDeadlines()).toHaveLength(3)
    expect((await listDeadlines('c1')).map((row) => row.title)).toEqual(['Diskrétna'])
    // Null is the value being matched rather than a sentinel to remember,
    // which is exactly what a loose deadline holds.
    expect((await listDeadlines(null)).map((row) => row.title)).toEqual(['Loose'])
  })
})

describe('listUpcoming', () => {
  // Insertion order and due order deliberately disagree, so a read that
  // returned rows in the order they were written passes nothing here.
  async function seed() {
    await createDeadline({ title: 'in five days', dueAt: daysAway(5) })
    await createDeadline({ title: 'today', dueAt: daysAway(0) })
    await createDeadline({ title: 'in nine days', dueAt: daysAway(9) })
    await createDeadline({ title: 'tomorrow', dueAt: daysAway(1) })
    await createDeadline({ title: 'in two days', dueAt: daysAway(2) })
  }

  it('orders soonest first, whatever order the rows were written in', async () => {
    await seed()

    const upcoming = await listUpcoming(10)

    expect(upcoming.map((row) => row.title)).toEqual([
      'today',
      'tomorrow',
      'in two days',
      'in five days',
      'in nine days',
    ])
  })

  it('excludes done, deleted and past', async () => {
    await seed()
    const past = await createDeadline({ title: 'last week', dueAt: daysAway(-7) })
    const ticked = await createDeadline({ title: 'finished', dueAt: daysAway(4) })
    await toggleDone(ticked.id)
    const gone = await createDeadline({ title: 'removed', dueAt: daysAway(3) })
    await deleteDeadline(gone.id)

    const titles = (await listUpcoming(20)).map((row) => row.title)

    expect(titles).not.toContain('last week')
    expect(titles).not.toContain('finished')
    expect(titles).not.toContain('removed')
    expect(titles).toHaveLength(5)
    expect(past.id).toBeDefined()
  })

  it('honours the limit, keeping the soonest rather than the first written', async () => {
    await seed()

    const upcoming = await listUpcoming(2)

    expect(upcoming.map((row) => row.title)).toEqual(['today', 'tomorrow'])
  })
})

describe('listOverdue', () => {
  it('is the complement of listUpcoming, and orders soonest first', async () => {
    await createDeadline({ title: 'three days ago', dueAt: daysAway(-3) })
    await createDeadline({ title: 'ten days ago', dueAt: daysAway(-10) })
    await createDeadline({ title: 'today', dueAt: daysAway(0) })
    await createDeadline({ title: 'tomorrow', dueAt: daysAway(1) })

    expect((await listOverdue()).map((row) => row.title)).toEqual([
      'ten days ago',
      'three days ago',
    ])
  })

  it('counts a deadline due today as upcoming and never as overdue', async () => {
    await createDeadline({ title: 'today', dueAt: daysAway(0) })

    expect((await listUpcoming(10)).map((row) => row.title)).toEqual(['today'])
    expect(await listOverdue()).toHaveLength(0)
  })

  it('excludes done and deleted', async () => {
    const ticked = await createDeadline({ title: 'finished', dueAt: daysAway(-2) })
    await toggleDone(ticked.id)
    const gone = await createDeadline({ title: 'removed', dueAt: daysAway(-2) })
    await deleteDeadline(gone.id)

    expect(await listOverdue()).toHaveLength(0)
  })
})

// The whole reason the comparison is a lexical one against the local calendar
// date. Both of these fail under an implementation that asks UTC what day it
// is, and they fail in opposite directions — which is why there are two.
//
// Only Date is faked. Faking the timers too would stop the event loop that
// fake-indexeddb runs its requests on, and every read below would hang.
describe('"today" is the reader\'s today', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('does not call today\'s deadline overdue when UTC has already rolled over', async () => {
    // 02:00 UTC on the 9th is 22:00 on the 8th in New York. The reader is
    // still on the 8th, so a deadline dated the 8th is due today. A UTC
    // implementation reads the 9th and files it as overdue.
    vi.stubEnv('TZ', 'America/New_York')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T02:00:00.000Z'))

    await createDeadline({ title: 'today for the reader', dueAt: day('2026-10-08') })

    expect((await listUpcoming(10)).map((row) => row.title)).toEqual([
      'today for the reader',
    ])
    expect(await listOverdue()).toHaveLength(0)
  })

  it('does call yesterday\'s deadline overdue when UTC has not yet rolled over', async () => {
    // 23:30 UTC on the 9th is 01:30 on the 10th in Bratislava. The reader is
    // already on the 10th, so a deadline dated the 9th is past. A UTC
    // implementation reads the 9th and still calls it upcoming.
    vi.stubEnv('TZ', 'Europe/Bratislava')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T23:30:00.000Z'))

    await createDeadline({ title: 'yesterday for the reader', dueAt: day('2026-10-09') })

    expect((await listOverdue()).map((row) => row.title)).toEqual([
      'yesterday for the reader',
    ])
    expect(await listUpcoming(10)).toHaveLength(0)
  })
})
