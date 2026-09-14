import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { User } from '../../sync/auth.ts'
import type { SyncStateValue } from '../../sync/state.ts'
import { DEBOUNCE_MS, dotStateOf, relative } from './format.ts'
import SyncDebug from './SyncDebug.tsx'

// The value only once it has stopped moving. Every change restarts the timer,
// so a state that comes and goes inside the window is never shown at all —
// which is the whole point rather than a side effect.
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (value === settled) return
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, settled, ms])
  return settled
}

type Props = {
  account: User | null
  sync: SyncStateValue
  online: boolean
  pending: number
  onSignOut: () => void
}

export default function SyncDot({ account, sync, online, pending, onSignOut }: Props) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [debug, setDebug] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const live = dotStateOf(sync, online, pending)
  const state = useSettled(live, DEBOUNCE_MS)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // The inner panel first: Escape closes one layer, which is what the key
      // means everywhere else in this app.
      setDebug((wasOpen) => {
        if (!wasOpen) setOpen(false)
        return false
      })
    }
    const onOutside = (event: PointerEvent) => {
      if (box.current?.contains(event.target as Node)) return
      setOpen(false)
      setDebug(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onOutside)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onOutside)
    }
  }, [open])

  // One sentence, used twice: on the dot, where it is the only thing a screen
  // reader gets, and in the panel, where it explains the colour to everyone
  // else. Two wordings would let them disagree.
  let words: string
  if (!online || sync.status === 'offline') words = t('sync.state.offline')
  else if (sync.status === 'unauthenticated') words = t('sync.state.signedOut')
  else if (sync.status === 'error') words = t('sync.state.failed')
  else if (sync.status === 'syncing') words = t('sync.state.syncing')
  else if (pending > 0) words = t('sync.state.pending', { count: pending })
  else words = t('sync.state.synced')

  return (
    <div className="sync-dot" ref={box}>
      <button
        type="button"
        className="dot"
        data-state={state}
        aria-expanded={open}
        aria-label={t('sync.dot', { state: words })}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      />

      {open && (
        // Not a modal: nothing behind it is blocked, and a panel about whether
        // the notes are safe must not stop anyone writing them.
        <div className="sync-panel" role="dialog" aria-label={t('sync.account')}>
          {account !== null && (
            <div className="sync-who">
              <strong>{account.display_name}</strong>
              <span className="meta">{account.username}</span>
              <span className="meta">{account.email}</span>
            </div>
          )}

          <dl className="sync-facts">
            <dt>{t('sync.stateLabel')}</dt>
            <dd>{words}</dd>
            <dt>{t('sync.lastSync')}</dt>
            <dd>
              {sync.lastSyncedAt === null
                ? t('sync.never')
                : relative(sync.lastSyncedAt, i18n.language)}
            </dd>
          </dl>

          <div className="sync-actions">
            <button
              type="button"
              onClick={() =>
                void i18n.changeLanguage(i18n.language === 'sk' ? 'en' : 'sk')
              }
            >
              {t('app.switchLanguage')}
            </button>
            <button type="button" onClick={onSignOut}>
              {t('auth.signOut')}
            </button>
            {/* Not behind a flag. A user reporting a problem is the person who
                most needs what is in here, and there is nothing in it they
                may not see. */}
            <button
              type="button"
              className="sync-debug-open"
              aria-label={t('sync.debug')}
              aria-expanded={debug}
              onClick={() => setDebug((wasOpen) => !wasOpen)}
            >
              <span aria-hidden="true">⚠</span>
            </button>
          </div>

          {debug && <SyncDebug sync={sync} />}
        </div>
      )}
    </div>
  )
}
