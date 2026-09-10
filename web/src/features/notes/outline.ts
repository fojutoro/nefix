// The headings of a note, which are its table of contents. A student thinks
// in topics, and the topics are already written down — this reads them back
// out rather than asking for them again.
//
// Pure, and deliberately not CodeMirror's parser: the card only needs the
// lines that begin with hashes, and pulling a Lezer tree in to find them
// would tie a list row to the editor's internals.
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+)$/
const FENCE = /^ {0,3}(?:```|~~~)/

export function outline(bodyMd: string): string[] {
  const headings: string[] = []
  let fenced = false
  let started = false

  for (const line of bodyMd.split('\n')) {
    if (FENCE.test(line)) {
      // A fence toggles, and everything between two of them is code, where a
      // leading hash is a comment. An unclosed fence swallows the rest of the
      // note, which is what a markdown renderer does with it too.
      fenced = !fenced
      started = true
      continue
    }
    if (fenced) continue
    if (line.trim() === '') continue

    const first = !started
    started = true
    const match = HEADING.exec(line)
    if (match === null) continue
    // deriveTitle takes the first line with anything on it and strips its
    // hashes, so a heading in that position is already the title on the row
    // above. Repeating it under itself is noise.
    if (first) continue
    // Closed ATX: `## Definícia ##` is the same heading as `## Definícia`.
    headings.push(match[2]!.replace(/[ \t]+#*[ \t]*$/, '').trim())
  }

  return headings
}
