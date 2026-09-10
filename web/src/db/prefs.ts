import { db } from './schema.ts'

// The range the rail is useful in. Narrower than 180 and the class names are
// all ellipsis; wider than 360 and it is taking width from the note.
export const RAIL_MIN = 180
export const RAIL_MAX = 360
export const RAIL_DEFAULT = 240

const RAIL_WIDTH = 'railWidth'

export const clampRail = (width: number): number =>
  Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(width)))

// Beside the notes rather than in localStorage, for the reason the sync
// cursor is: signing out clears this database, and a width left behind
// describes a rail the next account has not seen.
export async function readRailWidth(): Promise<number> {
  const row = await db.meta.get(RAIL_WIDTH)
  // Clamped on the way out too. A row from another version, or one edited by
  // hand, is not a reason to render a rail nobody can use.
  return typeof row?.value === 'number' ? clampRail(row.value) : RAIL_DEFAULT
}

export async function writeRailWidth(width: number): Promise<void> {
  await db.meta.put({ key: RAIL_WIDTH, value: clampRail(width) })
}
