import { useEffect, useState } from 'react'

// ADR 0005: dates are Intl, there is no date library. Coarse and
// approximate is the point — a note list needs "yesterday", not a duration.
const DIVISIONS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
  // Weeks are here for the rail, where three weeks of silence is the point
  // being made, and "21d" makes it arithmetic. The note list is no worse for
  // it: a week is coarser than a day count, which is what that list wants.
  ['week', 604_800_000],
  ['month', 2_592_000_000],
  ['year', 31_536_000_000],
]

// Floored, because no label here is finer than a minute and an unfloored
// clock would push a re-render every tick for a string that never changes.
const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000

// The clock these labels are read against. A hook and not Date.now() at
// render time, because a component that reads the clock while rendering is
// not a function of its props.
export function useMinute(): number {
  const [now, setNow] = useState(currentMinute)
  useEffect(() => {
    // Returning the previous value when the minute has not rolled over lets
    // React bail out, so a list nobody is touching does not re-render.
    const timer = setInterval(() => {
      setNow((previous) => {
        const minute = currentMinute()
        return minute === previous ? previous : minute
      })
    }, 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

// The unit and how many of them, unsigned. A relative time needs the sign
// back; a duration — "nothing here for three weeks" — must not have it, and
// both readings come off the same ladder.
export function divide(
  iso: string,
  now: number,
): [Intl.RelativeTimeFormatUnit, number] {
  // A note's updatedAt is never in the future. A clock floored past it should
  // read as "now" rather than as a prediction.
  const diff = Math.min(0, new Date(iso).getTime() - now)
  let unit = DIVISIONS[0]!
  for (const division of DIVISIONS) {
    if (Math.abs(diff) >= division[1]) unit = division
  }
  return [unit[0], Math.round(Math.abs(diff) / unit[1])]
}

// The formatter is the caller's, because the two lists that share this ladder
// do not share a style: the cards spell the unit out, the rail abbreviates it
// into a column two characters wide.
export function relative(
  iso: string,
  format: Intl.RelativeTimeFormat,
  now: number,
): string {
  const [unit, value] = divide(iso, now)
  return format.format(-value, unit)
}
