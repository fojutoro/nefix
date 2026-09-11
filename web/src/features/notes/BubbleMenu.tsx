import { type CSSProperties, type Ref } from 'react'
import type { Editor as TipTap } from '@tiptap/core'
import { useTranslation } from 'react-i18next'

// The document never loses focus while the menu is used — the toolbar refuses
// mousedown — and the selection the menu points at is on screen by definition,
// so there is nothing to scroll to and no reason to measure for it.
const KEEP = { scrollIntoView: false }

// Symbols on Apple hardware and words elsewhere, because `⌘` on Windows names
// no key at all. userAgent rather than the deprecated navigator.platform.
const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
const MOD = APPLE ? '⌘' : 'Ctrl+'
const SHIFT = APPLE ? '⇧' : 'Shift+'
const ALT = APPLE ? '⌥' : 'Alt+'

// The bindings StarterKit actually ships, read off the extensions rather than
// assumed: strike is Mod-Shift-S, not the Mod-Shift-X most editors use. A
// label naming the key people expect instead of the key that works sends them
// to press it and find nothing.
const MARKS = [
  { name: 'bold', glyph: 'B', keys: `${MOD}B` },
  { name: 'italic', glyph: 'I', keys: `${MOD}I` },
  { name: 'strike', glyph: 'S', keys: `${MOD}${SHIFT}S` },
  { name: 'code', glyph: '<>', keys: `${MOD}E` },
] as const

const LEVELS = [1, 2, 3] as const

type Props = {
  editor: TipTap
  top: number
  left: number
  // Under the selection rather than over it, for a selection sitting too near
  // the top of the pane for the menu to fit above.
  below: boolean
  link: boolean
  onLink: (open: boolean) => void
  onMath: () => void
  ref?: Ref<HTMLDivElement>
}

// Presentational: it reads the editor's own state for active marks and writes
// through commands, and it is told where to sit. Editor.tsx owns the
// measurement, because it already owns one for the formula field.
export default function BubbleMenu({
  editor,
  top,
  left,
  below,
  link,
  onLink,
  onMath,
  ref,
}: Props) {
  const { t } = useTranslation()

  const commitLink = (value: string) => {
    const href = value.trim()
    // extendMarkRange, so editing a link works from a caret anywhere inside it
    // rather than only from a selection covering the whole thing.
    const chain = editor.chain().focus(null, KEEP).extendMarkRange('link')
    if (href === '') chain.unsetLink().run()
    else chain.setLink({ href }).run()
    onLink(false)
  }

  return (
    <div
      ref={ref}
      className={below ? 'bubble-menu below' : 'bubble-menu'}
      style={{ top: `${top}px`, left: `${left}px` } as CSSProperties}
    >
      {link ? (
        <input
          className="bubble-link"
          aria-label={t('editor.linkUrl')}
          autoFocus
          defaultValue={(editor.getAttributes('link').href as string | undefined) ?? ''}
          spellCheck={false}
          onKeyDown={(event) => {
            // Held here, or Escape closes the note and `n` creates one.
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              commitLink(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onLink(false)
              editor.commands.focus(null, KEEP)
            }
          }}
        />
      ) : (
        // Refusing mousedown is what keeps the focus in the document. A
        // blurred editor has no selection, and no selection is nothing to
        // apply a mark to.
        <div
          className="bubble-row"
          onMouseDown={(event) => {
            event.preventDefault()
          }}
        >
          {MARKS.map(({ name, glyph, keys }) => (
            <button
              key={name}
              type="button"
              aria-label={t(`editor.${name}`)}
              aria-pressed={editor.isActive(name)}
              title={`${t(`editor.${name}`)} (${keys})`}
              onClick={() => editor.chain().focus(null, KEEP).toggleMark(name).run()}
            >
              {glyph}
            </button>
          ))}
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-label={t('editor.heading', { level })}
              aria-pressed={editor.isActive('heading', { level })}
              title={`${t('editor.heading', { level })} (${MOD}${ALT}${level})`}
              onClick={() =>
                editor.chain().focus(null, KEEP).toggleHeading({ level }).run()
              }
            >
              H{level}
            </button>
          ))}
          <button
            type="button"
            aria-label={t('editor.paragraph')}
            aria-pressed={editor.isActive('paragraph')}
            onClick={() => editor.chain().focus(null, KEEP).setParagraph().run()}
          >
            ¶
          </button>
          <button
            type="button"
            aria-label={t('editor.link')}
            aria-pressed={editor.isActive('link')}
            title={`${t('editor.link')} (${MOD}K)`}
            onClick={() => onLink(true)}
          >
            []
          </button>
          <button type="button" aria-label={t('editor.math')} onClick={onMath}>
            $
          </button>
        </div>
      )}
    </div>
  )
}
