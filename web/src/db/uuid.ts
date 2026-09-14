// UUIDv7 layout, 128 bits:
//   0-47    unix_ts_ms, big endian
//   48-51   version, 0b0111
//   52-63   counter, where RFC 9562 puts rand_a (§6.2, method 1)
//   64-65   variant, 0b10
//   66-127  rand_b
//
// Ids minted in this tab sort as plain strings in the order they were minted:
// the timestamp is in the high bits, and within one millisecond the counter
// after it counts up. That is all that is promised. Two tabs or two devices
// minting in the same millisecond interleave by their random bits, so anything
// that needs creation order across devices has to use a timestamp.
//
// Sync does not depend on this: the server pages by its own seq, and the note
// list orders by updatedAt. What reads rows in id order is listHeadings, whose
// order the topic picker shows, and push, which sends each table's dirty rows a
// hundred at a time in that order, so within a table older rows go first.

let lastMs = -1
let counter = 0

const COUNTER_MAX = 0xfff

export function uuidv7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  let ms = Date.now()
  if (ms > lastMs) {
    // A random start keeps one id from predicting the next, and the top bit
    // clear leaves at least 2048 steps before the millisecond runs out.
    counter = ((bytes[6]! << 8) | bytes[7]!) & 0x7ff
  } else {
    // The same millisecond, or a clock that moved backwards: staying on the
    // last timestamp is what stops the new id sorting before the previous one.
    ms = lastMs
    counter += 1
    if (counter > COUNTER_MAX) {
      // Out of room, so borrow the next millisecond, as the RFC allows.
      ms += 1
      counter = 0
    }
  }
  lastMs = ms

  // Date.now() exceeds 32 bits, so the top two bytes are taken by division
  // rather than by a bitwise shift, which would truncate to 32 bits.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = (ms >>> 24) & 0xff
  bytes[3] = (ms >>> 16) & 0xff
  bytes[4] = (ms >>> 8) & 0xff
  bytes[5] = ms & 0xff

  bytes[6] = 0x70 | (counter >>> 8)
  bytes[7] = counter & 0xff
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
