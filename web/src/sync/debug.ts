// Diagnostics for the sync cycle. Everything here is read-only with respect
// to the database: this module exists because data syncing correctly while
// the screen showed something else cost an hour, and a diagnostic that writes
// is a diagnostic that changes the thing it was asked to measure.

import { db } from '../db/schema.ts'
import { pull, ServerError } from './api.ts'

// Ten is enough to see a pattern — a cycle that pushed, one that pulled, the
// one that failed — and small enough that it is obviously not a log. In
// memory only: persisting it would make the debug panel a second thing that
// writes to the database, and it is meant to be the one thing that does not.
const KEEP = 10

export type PushRecord = {
  classes: number
  notebooks: number
  notes: number
  accepted: number
  conflicted: number
  forbidden: number
  failed: number
}

export type PullRecord = {
  classes: number
  notebooks: number
  notes: number
  applied: number
  skipped: number
  pages: number
  cursorBefore: number
  cursorAfter: number
}

export type CycleRecord = {
  at: number
  // Null rather than zeroes for a half that never ran. A cycle that was
  // refused before it pulled did not pull nothing; it did not pull.
  push: PushRecord | null
  pull: PullRecord | null
  error: { name: string; status: number | null; message: string } | null
}

let ring: CycleRecord[] = []
let open: CycleRecord | null = null

export function beginCycle(): void {
  open = { at: Date.now(), push: null, pull: null, error: null }
}

export function notePush(record: PushRecord): void {
  if (open !== null) open.push = record
}

export function notePull(record: PullRecord): void {
  if (open !== null) open.pull = record
}

export function endCycle(error: Error | null): void {
  if (open === null) return
  open.error =
    error === null
      ? null
      : {
          name: error.name,
          status: error instanceof ServerError ? error.status : null,
          message: error.message,
        }
  ring = [open, ...ring].slice(0, KEEP)
  open = null
}

// Newest first, so the panel reads top down without reversing anything.
export function cycles(): CycleRecord[] {
  return ring
}

export function resetCycles(): void {
  ring = []
  open = null
}

export type TableCount = { rows: number; dirty: number }

export type LocalSnapshot = {
  cursor: number
  classes: TableCount
  notebooks: TableCount
  notes: TableCount
  dexie: number
}

const CURSOR = 'syncCursor'

async function readCursor(): Promise<number> {
  const row = await db.meta.get(CURSOR)
  return typeof row?.value === 'number' ? row.value : 0
}

export async function localSnapshot(): Promise<LocalSnapshot> {
  const count = async (table: {
    count: () => Promise<number>
    filter: (fn: (row: { dirty: boolean }) => boolean) => { count: () => Promise<number> }
  }): Promise<TableCount> => ({
    rows: await table.count(),
    dirty: await table.filter((row) => row.dirty).count(),
  })

  const [cursor, classes, notebooks, notes] = await Promise.all([
    readCursor(),
    count(db.classes),
    count(db.notebooks),
    count(db.notes),
  ])
  return { cursor, classes, notebooks, notes, dexie: db.verno }
}

export type Comparison = {
  serverRows: number
  localRows: number
  onlyOnServer: number
  onlyLocal: number
  versionDiffers: number
}

const PAGE = 100
const MAX_PAGES = 50

// Everything the server holds, from the beginning, counted and thrown away.
// It asks with since=0 rather than the stored cursor because the question is
// "what does the server actually have", and asking from the cursor can only
// ever answer "nothing new" — which is exactly what a client with a wrong
// cursor also says.
export async function compareWithServer(): Promise<Comparison> {
  const remote = new Map<string, number>()
  let since = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await pull(since, PAGE)
    for (const row of response.classes) remote.set(row.id, row.version)
    for (const row of response.notebooks) remote.set(row.id, row.version)
    for (const row of response.notes) remote.set(row.id, row.version)
    since = response.cursor
    if (!response.has_more) break
  }

  // Ids are unique across the three tables, which is what lets one map
  // answer for all of them.
  const local = new Map<string, number>()
  for (const row of await db.classes.toArray()) local.set(row.id, row.version)
  for (const row of await db.notebooks.toArray()) local.set(row.id, row.version)
  for (const row of await db.notes.toArray()) local.set(row.id, row.version)

  let onlyOnServer = 0
  let versionDiffers = 0
  for (const [id, version] of remote) {
    const mine = local.get(id)
    if (mine === undefined) onlyOnServer += 1
    else if (mine !== version) versionDiffers += 1
  }
  let onlyLocal = 0
  for (const id of local.keys()) if (!remote.has(id)) onlyLocal += 1

  return {
    serverRows: remote.size,
    localRows: local.size,
    onlyOnServer,
    onlyLocal,
    versionDiffers,
  }
}
