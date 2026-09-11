import { type CSSProperties, type Ref } from 'react'
import type { Labelled } from './blocks.ts'

type Props = {
  items: Labelled[]
  picked: number
  top: number
  left: number
  // Opened by the + button, so the keys land here rather than in the document.
  // The slash menu leaves focus in the text and is driven from Editor's own
  // key handler instead.
  focus: boolean
  onPick: (index: number) => void
  onRun: (item: Labelled) => void
  onMove: (delta: number) => void
  // true when the menu is closing with the focus still on it, so the document
  // needs it handed back.
  onClose: (refocus: boolean) => void
  ref?: Ref<HTMLDivElement>
}

// Presentational, like BubbleMenu: it is told what to list, which row is
// selected and where to sit. Editor.tsx owns the measurement and the filtering,
// because it already owns a measurement for the formula field and the bubble
// menu and there is no reason for a third one to live somewhere else.
export default function BlockMenu({
  items,
  picked,
  top,
  left,
  focus,
  onPick,
  onRun,
  onMove,
  onClose,
  ref,
}: Props) {
  return (
    <div
      ref={ref}
      className="block-menu"
      role="listbox"
      // Focusable but not in the tab order: the menu is a transient surface
      // reached by typing `/` or pressing the button, never by tabbing to it.
      tabIndex={-1}
      autoFocus={focus}
      style={{ top: `${top}px`, left: `${left}px` } as CSSProperties}
      onKeyDown={(event) => {
        // App.tsx listens on the window and never asks whether anyone dealt
        // with the key. A button is not contenteditable and is not an input,
        // so its guard does not cover this element and `n` would create a note
        // out from under an open menu.
        event.stopPropagation()
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          onMove(1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          onMove(-1)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          const item = items[picked]
          if (item !== undefined) onRun(item)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onClose(true)
        }
      }}
      // Clicking away is the only other way out of the + button's menu: its
      // own options refuse mousedown, so they never blur it. The focus has
      // already gone somewhere else by now and must not be taken back.
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        onClose(false)
      }}
      // Refusing mousedown keeps the selection in the document, which is what
      // every command here acts on.
      onMouseDown={(event) => {
        event.preventDefault()
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.command.id}
          type="button"
          role="option"
          aria-selected={index === picked}
          // The command's identity, so a test can assert that both triggers
          // ran the same one rather than that two labels happened to match.
          data-command={item.command.id}
          onMouseEnter={() => onPick(index)}
          onClick={() => onRun(item)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
