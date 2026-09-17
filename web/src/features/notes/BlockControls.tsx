import { useEffect, useRef, type CSSProperties } from 'react'
import type { Editor as TipTap } from '@tiptap/core'
import { selectedRect } from '@tiptap/pm/tables'
import { useTranslation } from 'react-i18next'
import {
  KEEP,
  TURN_INTO,
  canShiftBlock,
  deleteBlock,
  duplicateBlock,
  shiftBlock,
} from './blocks.ts'

const TABLE = [
  { command: 'addRowBefore', labelKey: 'table.rowAbove' },
  { command: 'addRowAfter', labelKey: 'table.rowBelow' },
  { command: 'addColumnBefore', labelKey: 'table.columnLeft' },
  { command: 'addColumnAfter', labelKey: 'table.columnRight' },
  { command: 'deleteRow', labelKey: 'table.deleteRow' },
  { command: 'deleteColumn', labelKey: 'table.deleteColumn' },
  { command: 'deleteTable', labelKey: 'table.delete' },
] as const
// No toggleHeaderRow, on purpose. Markdown tables require a header row, so a
// table with it turned off saves an empty header row and reopens with a blank
// strip on top. A menu item that silently corrupts the table is worse than a
// missing one.

function inTable(editor: TipTap) {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') return true
  }
  return false
}

// can() says yes to deleting every row, or every column, a table has:
// prosemirror-tables only refuses that once it is dispatching, which a dry run
// never reaches. Without this the last row of a one-row table shows enabled
// and does nothing when pressed.
function removesAll(editor: TipTap, command: (typeof TABLE)[number]['command']) {
  if (command !== 'deleteRow' && command !== 'deleteColumn') return false
  const rect = selectedRect(editor.state)
  return command === 'deleteRow'
    ? rect.top === 0 && rect.bottom === rect.map.height
    : rect.left === 0 && rect.right === rect.map.width
}

type Item = { id: string; label: string; disabled?: boolean; run: () => void }

type Props = {
  editor: TipTap
  top: number
  // true when the menu is closing with the focus still on it, so the document
  // needs it handed back.
  onClose: (refocus: boolean) => void
}

// Presentational, like BlockMenu, and read fresh on every render: the menu
// closes after each command, so what it shows is never older than the
// selection it was opened on.
export default function BlockControls({ editor, top, onClose }: Props) {
  const { t } = useTranslation()
  const self = useRef<HTMLDivElement>(null)
  const table = inTable(editor)

  // Not autoFocus: React only honours it on form controls, and on this div it
  // did nothing, which left the keys in the document — Escape went on to
  // App.tsx and closed the note. The first item, as a menu does.
  useEffect(() => {
    self.current?.querySelector<HTMLButtonElement>('button:enabled')?.focus()
  }, [])

  const block: Item[] = [
    { id: 'delete', label: t('block.delete'), run: () => deleteBlock(editor) },
    { id: 'duplicate', label: t('block.duplicate'), run: () => duplicateBlock(editor) },
  ]
  // Absent rather than disabled: at the top of a note there is no "up", and a
  // greyed-out row would suggest there could be.
  if (canShiftBlock(editor, -1)) {
    block.push({ id: 'moveUp', label: t('block.moveUp'), run: () => shiftBlock(editor, -1) })
  }
  if (canShiftBlock(editor, 1)) {
    block.push({ id: 'moveDown', label: t('block.moveDown'), run: () => shiftBlock(editor, 1) })
  }

  // Not inside a table: a markdown table cell holds inline text only, and a
  // heading put in one saves as `| ## 1 |` and reopens as those literal
  // characters.
  const turnInto: Item[] = table
    ? []
    : TURN_INTO.map((command) => ({
        id: command.id,
        label: t(command.labelKey, command.labelArgs),
        run: () => command.run(editor, () => {}),
      }))

  // Disabled rather than absent, so the section keeps its shape while the
  // cursor moves around the table and a row is where it was a moment ago.
  const tableItems: Item[] = table
    ? TABLE.map(({ command, labelKey }) => ({
        id: command,
        label: t(labelKey),
        disabled: !editor.can()[command]() || removesAll(editor, command),
        run: () => editor.chain().focus(null, KEEP)[command]().run(),
      }))
    : []

  const sections = [
    { id: 'block', label: null, items: block },
    { id: 'turnInto', label: t('block.turnInto'), items: turnInto },
    { id: 'table', label: t('block.table'), items: tableItems },
  ].filter((section) => section.items.length > 0)

  const step = (menu: HTMLElement, delta: number) => {
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:enabled'))
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = at === -1 ? (delta > 0 ? 0 : buttons.length - 1) : at + delta
    buttons[(next + buttons.length) % buttons.length]?.focus()
  }

  return (
    <div
      className="block-controls"
      role="menu"
      ref={self}
      tabIndex={-1}
      style={{ top: `${top}px` } as CSSProperties}
      onKeyDown={(event) => {
        // Held here for the reason BlockMenu holds it: App.tsx's window
        // handler would take `n` for a new note and Escape for closing this one.
        event.stopPropagation()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          step(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onClose(true)
        }
      }}
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
      {sections.map((section) => (
        <div key={section.id} role="group" aria-label={section.label ?? undefined}>
          {section.label !== null && <div className="block-controls-label">{section.label}</div>}
          {section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-command={item.id}
              disabled={item.disabled}
              onClick={() => {
                onClose(false)
                item.run()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
