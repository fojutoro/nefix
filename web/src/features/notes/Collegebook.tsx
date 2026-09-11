import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Note } from '../../db/schema.ts'
import Editor from './Editor.tsx'
import { useAutosave, type SaveNote } from './useAutosave.ts'

// How far outside the viewport a page still counts as near it. A page is
// about a screen tall, so one viewport either way keeps the neighbour above
// and the one below built before the reader reaches them, and keeps a book of
// twenty pages from holding twenty TipTap instances at once.
const NEAR = '100%'

// How many pages are built before the observer has reported anything. A book
// opens on its first page rather than on a placeholder, and the pages arrive
// from IndexedDB after this component mounts, so this cannot be a one-off
// initial state: it is the answer until the observer has spoken.
const FIRST = 2

type PageProps = {
  page: Note
  number: number
  total: number
  mounted: boolean
  label: string
  mathLabel: string
  untitled: string
  save: SaveNote
}

function Page({
  page,
  number,
  total,
  mounted,
  label,
  mathLabel,
  untitled,
  save,
}: PageProps) {
  // One autosave per page, so one pending write per page. Sharing a hook
  // across the stack would let the debounce started on page 2 land on
  // whichever page was typed in last.
  const onChange = useAutosave(page.id, untitled, save)

  return (
    <li className="book-page" data-page={page.id}>
      {mounted ? (
        // Its own editor, and so its own echo-back guard: the guard watches
        // the row it was given, and a page being typed into must not be
        // overwritten by a pull landing on another page in the same book.
        <Editor
          noteId={page.id}
          initialBody={page.bodyMd}
          label={label}
          mathLabel={mathLabel}
          focus={false}
          onChange={onChange}
        />
      ) : (
        // The text rather than an empty box: a reader scrolling through a
        // book should see pages go by, not blank rectangles, and the words
        // stay in the accessibility tree while the editor is not built.
        // Its height is the one the observer last measured, stored on the
        // page element itself: a placeholder at the nominal height would
        // shrink a page that had overflowed, and the scroll position would
        // jump under the reader the moment a page they had already passed
        // was torn down. The nominal height is the fallback, in the
        // stylesheet, for a page that has never been on screen.
        <div className="page-holder">{page.bodyMd}</div>
      )}
      {/* Where the page nominally ends. Content that runs past it pushes the
          break down rather than being cut off: pages are manual, and nothing
          here measures blocks or reflows them into the next page. */}
      <p className="page-break">
        <span className="meta">
          {number} / {total}
        </span>
      </p>
    </li>
  )
}

type Props = {
  pages: Note[]
  label: string
  mathLabel: string
  untitled: string
  save: SaveNote
  onCreatePage: () => void
}

export default function Collegebook({
  pages,
  label,
  mathLabel,
  untitled,
  save,
  onCreatePage,
}: Props) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  // Null until the observer's first report. The observer describes every page
  // it watches as soon as it is built, so this is the state of a book whose
  // pages have not been laid out yet, not a state it lingers in.
  const [near, setNear] = useState<string[] | null>(null)

  useEffect(() => {
    const root = box.current
    if (root === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Remembered on the element rather than in a ref, because a ref may
          // not be read while rendering and this value is only ever needed by
          // the placeholder that replaces the editor. Zero is skipped: a page
          // mid-teardown has no height worth keeping.
          const height = entry.boundingClientRect.height
          if (height > 0) {
            const element = entry.target as HTMLElement
            element.style.setProperty('--measured', `${height}px`)
          }
        }
        setNear((current) => {
          const next = new Set(current ?? [])
          let changed = current === null
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.page
            if (id === undefined) continue
            if (entry.isIntersecting) {
              if (!next.has(id)) {
                next.add(id)
                changed = true
              }
            } else if (next.delete(id)) {
              changed = true
            }
          }
          // The same array when nothing moved, so React bails out rather than
          // re-rendering every page in the book on each scroll callback.
          return changed ? [...next] : current
        })
      },
      { root, rootMargin: NEAR },
    )
    for (const page of root.querySelectorAll('[data-page]')) {
      observer.observe(page)
    }
    return () => observer.disconnect()
  }, [pages])

  return (
    <div className="book" ref={box}>
      <ul className="book-pages" aria-label={t('book.pagesLabel')}>
        {pages.map((page, index) => (
          <Page
            key={page.id}
            page={page}
            number={index + 1}
            total={pages.length}
            mounted={
              near === null ? index < FIRST : near.includes(page.id)
            }
            label={label}
            mathLabel={mathLabel}
            untitled={untitled}
            save={save}
          />
        ))}
      </ul>
      <button type="button" className="book-add" onClick={onCreatePage}>
        {t('book.newPage')}
      </button>
    </div>
  )
}
