import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { clampRail, RAIL_DEFAULT } from '../../db/prefs.ts'

type Props = {
  width: number
  onResize: (width: number) => void
  onCommit: (width: number) => void
}

export default function RailHandle({ width, onResize, onCommit }: Props) {
  const { t } = useTranslation()

  // Mouse events and not pointer events: below 900px the rail is a drawer, so
  // there is nothing to drag on a touch screen, and what pointer events would
  // add here is a capture API for a case that does not arise.
  const grab = (event: MouseEvent) => {
    // Or the drag selects the text either side of the handle.
    event.preventDefault()
    let latest = width
    const move = (moved: globalThis.MouseEvent) => {
      // The rail starts at the left edge of the window, so the pointer's x is
      // the width. Clamped here rather than in the layout, so the number that
      // gets stored is the number that was used.
      latest = clampRail(moved.clientX)
      onResize(latest)
    }
    const drop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
      // Once per drag. A write per mousemove would be sixty rows a second.
      onCommit(latest)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
  }

  return (
    <div
      className="rail-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('rail.resize')}
      aria-valuenow={width}
      onMouseDown={grab}
      onDoubleClick={() => {
        onResize(RAIL_DEFAULT)
        onCommit(RAIL_DEFAULT)
      }}
    />
  )
}
