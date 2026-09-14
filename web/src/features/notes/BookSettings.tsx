import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GRAIN,
  INSET,
  LINES,
  PITCH,
  READABLE,
  TEXT_SIZE,
  contrast,
  parseHex,
  type BookSettings as Settings,
  type Face,
  type Ruling,
} from '../../db/settings.ts'

// Eight each, and the two rows are chosen against each other: every ink here
// clears 4.5:1 on the light papers, and the two dark papers are there for the
// two pale inks. Presets are the fast path and most readers will never leave
// them, which is why they come before the field and the picker.
const PAPERS = [
  '#faf6ef',
  '#ffffff',
  '#fdf6e3',
  '#f1f5f2',
  '#eef2f7',
  '#e9e4d9',
  '#2b2a27',
  '#16202b',
]
const INKS = [
  '#1a1917',
  '#000000',
  '#3b3a36',
  '#243b53',
  '#14453d',
  '#5a3e2b',
  '#f2ede3',
  '#ffffff',
]

type ColourProps = {
  label: string
  hexLabel: string
  swatchLabel: string
  optionLabel: (n: number) => string
  value: string
  presets: string[]
  onPick: (hex: string) => void
}

// Three ways to the same value, because they suit three different people: a
// swatch for someone who wants one that works, a field for someone who has a
// hex already, and the native picker because it is free and it is what the
// swatch itself looks like it should do.
function Colour({
  label,
  hexLabel,
  swatchLabel,
  optionLabel,
  value,
  presets,
  onPick,
}: ColourProps) {
  // The field holds what was typed, not the colour. Half a hex is not a
  // request to change anything, and a field that snapped back to the current
  // colour on every unfinished keystroke could not be typed into at all.
  const [typed, setTyped] = useState(value)
  // The colour changing from outside — a swatch, the picker, a reset — writes
  // it into the field. State rather than a ref, because a ref may not be read
  // while rendering, and this is the documented way to adjust state when a
  // prop changes.
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setTyped(value)
  }

  const take = (input: string) => {
    setTyped(input)
    const hex = parseHex(input)
    if (hex !== null) onPick(hex)
  }

  return (
    <div className="set-colour" role="group" aria-label={label}>
      <span className="set-label">{label}</span>
      <div className="set-swatches">
        {presets.map((hex, index) => (
          <button
            key={hex}
            type="button"
            className="set-swatch"
            aria-label={optionLabel(index + 1)}
            aria-pressed={hex === value}
            style={{ background: hex }}
            onClick={() => onPick(hex)}
          />
        ))}
      </div>
      <div className="set-row">
        <input
          type="text"
          className="set-hex"
          aria-label={hexLabel}
          value={typed}
          spellCheck={false}
          onChange={(event) => take(event.target.value)}
        />
        <input
          type="color"
          className="set-picker"
          aria-label={swatchLabel}
          value={value}
          onChange={(event) => onPick(event.target.value)}
        />
      </div>
    </div>
  )
}

type SliderProps = {
  label: string
  bounds: { min: number; max: number; step: number }
  value: number
  format: (value: number) => string
  onSlide: (value: number) => void
}

function Slider({ label, bounds, value, format, onSlide }: SliderProps) {
  // How far along the track the thumb is. CSS can draw the filled portion of
  // a range input only as a gradient, and a gradient cannot know the value:
  // this is the one number the stylesheet cannot work out for itself.
  const fill = ((value - bounds.min) / (bounds.max - bounds.min)) * 100

  return (
    <label className="set-slider" style={{ '--fill': `${fill}%` } as CSSProperties}>
      <span className="set-label">{label}</span>
      {/* Named explicitly rather than by the wrapping label: the readout to
          its right is inside that label too, so without this the control
          would announce itself as "Line pitch 1.60×" and rename itself every
          time it moved. */}
      <input
        type="range"
        aria-label={label}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={value}
        onChange={(event) => onSlide(Number(event.target.value))}
      />
      <span className="meta">{format(value)}</span>
    </label>
  )
}

function Check({
  label,
  checked,
  onToggle,
}: {
  label: string
  checked: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <label className="set-check">
      <span className="set-label">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
      />
    </label>
  )
}

type Props = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
}

const RULINGS: Ruling[] = ['none', 'ruled', 'squared']
const FACES: Face[] = ['sans', 'serif', 'mono']

export default function BookSettings({ settings, onChange, onReset }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    // pointerdown rather than click: a click that begins inside the panel and
    // ends outside it is a drag on a slider, and closing under the hand would
    // make every slider in here unusable near its edges.
    const onOutside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onOutside)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onOutside)
    }
  }, [open])

  const ratio = contrast(settings.ink, settings.paper)
  const times = (value: number) => `${value.toFixed(2)}×`

  return (
    <div className="book-gear" ref={box}>
      <button
        type="button"
        className="gear"
        aria-label={t('book.settings')}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">⚙</span>
      </button>

      {open && (
        // Not a modal: the page behind stays readable and usable, which is the
        // whole point of a control that changes how it looks.
        <div className="book-settings" role="dialog" aria-label={t('book.settings')}>
          <fieldset>
            <legend>{t('book.ruling')}</legend>
            {/* One control, not two. 'none' is the ruling switched off, and a
                separate on/off beside this would be a second control for the
                same bit — with nothing to say which of them wins. */}
            <div className="set-choice" role="radiogroup" aria-label={t('book.ruling')}>
              {RULINGS.map((option) => (
                <label key={option} className="set-segment">
                  <input
                    type="radio"
                    name="ruling"
                    checked={settings.ruling === option}
                    onChange={() => onChange({ ruling: option })}
                  />
                  {t(`book.ruling.${option}`)}
                </label>
              ))}
            </div>
            <Slider
              label={t('book.pitch')}
              bounds={PITCH}
              value={settings.pitch}
              format={times}
              onSlide={(pitch) => onChange({ pitch })}
            />
          </fieldset>

          <fieldset>
            <legend>{t('book.marginRule')}</legend>
            <Check
              label={t('book.marginRule')}
              checked={settings.ruleOn}
              onToggle={(ruleOn) => onChange({ ruleOn })}
            />
            <Slider
              label={t('book.inset')}
              bounds={INSET}
              value={settings.ruleInset}
              format={(value) => `${value}%`}
              onSlide={(ruleInset) => onChange({ ruleInset })}
            />
          </fieldset>

          <fieldset>
            <legend>{t('book.page')}</legend>
            <Check
              label={t('book.pageNumbers')}
              checked={settings.pageNumbers}
              onToggle={(pageNumbers) => onChange({ pageNumbers })}
            />
            <Slider
              label={t('book.pageHeight')}
              bounds={LINES}
              value={settings.pageLines}
              format={(value) => t('book.lines', { count: value })}
              onSlide={(pageLines) => onChange({ pageLines })}
            />
            <Colour
              label={t('book.paper')}
              hexLabel={t('book.paperHex')}
              swatchLabel={t('book.paperSwatch')}
              optionLabel={(n) => t('book.paperOption', { n })}
              value={settings.paper}
              presets={PAPERS}
              onPick={(paper) => onChange({ paper })}
            />
            <Check
              label={t('book.grain')}
              checked={settings.grainOn}
              onToggle={(grainOn) => onChange({ grainOn })}
            />
            <Slider
              label={t('book.grainStrength')}
              bounds={GRAIN}
              value={settings.grain}
              format={(value) => `${Math.round(value * 100)}%`}
              onSlide={(grain) => onChange({ grain })}
            />
          </fieldset>

          <fieldset>
            <legend>{t('book.text')}</legend>
            <Slider
              label={t('book.textSize')}
              bounds={TEXT_SIZE}
              value={settings.textSize}
              format={times}
              onSlide={(textSize) => onChange({ textSize })}
            />
            <Colour
              label={t('book.ink')}
              hexLabel={t('book.inkHex')}
              swatchLabel={t('book.inkSwatch')}
              optionLabel={(n) => t('book.inkOption', { n })}
              value={settings.ink}
              presets={INKS}
              onPick={(ink) => onChange({ ink })}
            />
            {/* Named stacks only. Nothing here is fetched, and nothing here
                may be: a font that arrives over the network is a font a book
                does not have on the train. */}
            <label className="set-slider">
              <span className="set-label">{t('book.font')}</span>
              <select
                className="set-select"
                value={settings.face}
                onChange={(event) => onChange({ face: event.target.value as Face })}
              >
                {FACES.map((option) => (
                  <option key={option} value={option}>
                    {t(`book.font.${option}`)}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          {/* Said, never enforced. Someone may want a watermark, and the
              controls above stay live while this is showing — but a reader who
              cannot make out their own notes should not have to guess why. */}
          {ratio < READABLE && (
            <p className="set-warning" role="status">
              {t('book.lowContrast', { ratio: ratio.toFixed(1) })}
            </p>
          )}

          <button
            type="button"
            className="set-reset"
            onClick={() => {
              if (window.confirm(t('book.resetConfirm'))) onReset()
            }}
          >
            {t('book.reset')}
          </button>
        </div>
      )}
    </div>
  )
}
