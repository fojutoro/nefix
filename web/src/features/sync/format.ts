// The dot's three pure decisions, out of the component because a .tsx that
// exports anything but components breaks fast refresh, and the lint rule says
// so. Testable on their own as a consequence, which is the better half of the
// trade.

import type { SyncStateValue } from '../../sync/state.ts'

// How long a state has to hold before the dot adopts it. A sync cycle is over
// in well under a second, and a dot that went yellow and back for every one of
// them would be a blinking light in the corner of the eye of someone writing.
// The dot is not a progress indicator: it answers "is my work safe", and that
// answer does not change every two seconds.
export const DEBOUNCE_MS = 1200

export type DotState = 'green' | 'yellow' | 'red'

// navigator.onLine leads, for the reason the status line this replaced gave:
// it reports the loss before a request has to fail to discover it.
export function dotStateOf(
  sync: SyncStateValue,
  online: boolean,
  pending: number,
): DotState {
  if (!online) return 'red'
  if (sync.status === 'offline' || sync.status === 'error') return 'red'
  if (sync.status === 'unauthenticated') return 'red'
  if (sync.status === 'syncing') return 'yellow'
  return pending > 0 ? 'yellow' : 'green'
}

// Moved from App.tsx, which no longer shows a time: the footer is a dot now.
// Coarse on purpose — nothing re-renders on a timer, so a minute is the finest
// unit it can keep honest. Not features/notes/relative.ts: that one takes an
// ISO string and a formatter the caller owns, and these are epoch
// milliseconds.
export function relative(at: number, language: string): string {
  const seconds = Math.round((at - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (seconds > -60) return format.format(seconds, 'second')
  if (seconds > -3600) return format.format(Math.round(seconds / 60), 'minute')
  return format.format(Math.round(seconds / 3600), 'hour')
}
