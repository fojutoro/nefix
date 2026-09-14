import type { TFunction } from 'i18next'

const DAY_MS = 86_400_000

// Whole days from the reader's today to the due date, negative once it has
// passed. Both ends are UTC midnights — the stored date, and the reader's own
// calendar date re-read as UTC — so the difference is an exact multiple of a
// day and a clock change between them cannot make it 2.96. Today is the local
// calendar's for the reason db/deadlines.ts gives.
export function daysUntil(dueAt: string, now: number): number {
  const local = new Date(now)
  const today = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate())
  return Math.round((Date.parse(dueAt.slice(0, 10)) - today) / DAY_MS)
}

export type Countdown = { text: string; late: boolean }

export function countdown(
  dueAt: string,
  done: boolean,
  now: number,
  language: string,
  t: TFunction,
): Countdown {
  const days = daysUntil(dueAt, now)
  // A finished deadline in the past was not missed, so it is only dated.
  if (days >= 0 || done) {
    // numeric: 'auto' is what says "today" and "tomorrow" rather than
    // "in 0 days".
    const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
    return { text: format.format(days, 'day'), late: false }
  }
  const span = new Intl.NumberFormat(language, {
    style: 'unit',
    unit: 'day',
    unitDisplay: 'long',
  }).format(-days)
  return { text: t('deadlines.late', { when: span }), late: true }
}
