import { useCallback, useEffect, useRef } from 'react'

const DEBOUNCE_MS = 500
const TITLE_MAX = 200

export type SaveNote = (
  id: string,
  patch: { bodyMd: string; title: string },
) => Promise<void>

// Applied on every save, never stored independently, so the title cannot
// drift from the body that produced it. Leading blank lines are skipped:
// pressing Enter before typing should not cost the note its title.
export function deriveTitle(bodyMd: string, untitled: string): string {
  for (const line of bodyMd.split('\n')) {
    const title = line.replace(/^[#\s]+/, '').trim().slice(0, TITLE_MAX)
    if (title !== '') return title
  }
  return untitled
}

export function useAutosave(
  noteId: string | null,
  untitled: string,
  save: SaveNote,
): (bodyMd: string) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The pending write carries the id it was typed into, so a note switch
  // cannot redirect it at the note that replaced it.
  const pending = useRef<{ id: string; bodyMd: string } | null>(null)
  const latest = useRef({ noteId, untitled, save })

  useEffect(() => {
    latest.current = { noteId, untitled, save }
  })

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const write = pending.current
    pending.current = null
    if (write === null) return
    void latest.current.save(write.id, {
      bodyMd: write.bodyMd,
      title: deriveTitle(write.bodyMd, latest.current.untitled),
    })
  }, [])

  useEffect(() => {
    // beforeunload is unreliable on mobile Safari, which is exactly the
    // platform this has to survive. visibilitychange and pagehide fire there.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', flush)
    }
  }, [flush])

  // Cancels the timer and then writes, on unmount and on every note switch.
  // A component going away is not a reason to lose what was typed into it.
  useEffect(() => {
    return () => flush()
  }, [noteId, flush])

  return useCallback(
    (bodyMd: string) => {
      const id = latest.current.noteId
      if (id === null) return
      pending.current = { id, bodyMd }
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(flush, DEBOUNCE_MS)
    },
    [flush],
  )
}
