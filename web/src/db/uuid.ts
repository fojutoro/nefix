// UUIDv7 layout, 128 bits:
//   0-47    unix_ts_ms, big endian
//   48-51   version, 0b0111
//   52-63   rand_a
//   64-65   variant, 0b10
//   66-127  rand_b
// The timestamp occupies the high bits, so the hex form sorts by creation
// time as a plain string. That ordering is what phase 4's cursor sync and
// the newest-first listing rely on, so it is not cosmetic.
export function uuidv7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  const ms = Date.now()
  // Date.now() exceeds 32 bits, so the top two bytes are taken by division
  // rather than by a bitwise shift, which would truncate to 32 bits.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = (ms >>> 24) & 0xff
  bytes[3] = (ms >>> 16) & 0xff
  bytes[4] = (ms >>> 8) & 0xff
  bytes[5] = ms & 0xff

  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
