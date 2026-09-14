import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { health, type Health } from '../../sync/api.ts'
import {
  compareWithServer,
  cycles,
  localSnapshot,
  type Comparison,
  type LocalSnapshot,
} from '../../sync/debug.ts'
import type { SyncStateValue } from '../../sync/state.ts'
import { relative } from './format.ts'

// Everything here is read. The comparison below asks the server for its whole
// history and counts it, and nothing on this screen writes a row: the bug this
// panel exists for is data syncing correctly while the screen showed something
// else, and a diagnostic that writes cannot tell you which of the two it is.

type Props = { sync: SyncStateValue }

export default function SyncDebug({ sync }: Props) {
  const { t, i18n } = useTranslation()
  const [local, setLocal] = useState<LocalSnapshot | null>(null)
  const [build, setBuild] = useState<Health | null>(null)
  const [diff, setDiff] = useState<Comparison | null>(null)
  const [comparing, setComparing] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    void localSnapshot().then(setLocal)
    // A build that cannot be reached is a fact about the session, not an
    // error worth showing twice: the dot already says it.
    void health()
      .then(setBuild)
      .catch(() => setBuild(null))
  }, [])

  const compare = async () => {
    setComparing(true)
    setFailed(null)
    try {
      setDiff(await compareWithServer())
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setComparing(false)
    }
  }

  const when = (at: number) => relative(at, i18n.language)
  const history = cycles()

  return (
    <div className="sync-diag" role="dialog" aria-label={t('sync.debug')}>
      <dl className="sync-facts">
        <dt>{t('sync.cursor')}</dt>
        <dd>{local === null ? '—' : local.cursor}</dd>
        <dt>{t('sync.dexie')}</dt>
        <dd>{local === null ? '—' : local.dexie}</dd>
        <dt>{t('sync.build')}</dt>
        <dd>{build === null ? '—' : `${build.version} (${build.commit})`}</dd>
      </dl>

      <table className="sync-counts">
        <thead>
          <tr>
            <th>{t('sync.table')}</th>
            <th>{t('sync.rows')}</th>
            <th>{t('sync.dirty')}</th>
          </tr>
        </thead>
        <tbody>
          {(['classes', 'notebooks', 'notes'] as const).map((table) => (
            <tr key={table}>
              <th scope="row">{t(`sync.table.${table}`)}</th>
              <td>{local === null ? '—' : local[table].rows}</td>
              <td>{local === null ? '—' : local[table].dirty}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {sync.lastError !== null && (
        <p className="sync-error">
          {sync.lastError.name}: {sync.lastError.message}
        </p>
      )}

      <button type="button" onClick={() => void compare()} disabled={comparing}>
        {comparing ? t('sync.comparing') : t('sync.compare')}
      </button>

      {failed !== null && <p className="sync-error">{failed}</p>}

      {diff !== null && (
        <dl className="sync-facts">
          <dt>{t('sync.serverRows')}</dt>
          <dd>{diff.serverRows}</dd>
          <dt>{t('sync.localRows')}</dt>
          <dd>{diff.localRows}</dd>
          <dt>{t('sync.onlyServer')}</dt>
          <dd>{diff.onlyOnServer}</dd>
          <dt>{t('sync.onlyLocal')}</dt>
          <dd>{diff.onlyLocal}</dd>
          <dt>{t('sync.versionDiffers')}</dt>
          <dd>{diff.versionDiffers}</dd>
        </dl>
      )}

      {/* Ten cycles, in memory. History rather than only the last event,
          because the question is usually "what happened just before". */}
      <ol className="sync-cycles">
        {history.length === 0 && <li className="meta">{t('sync.noCycles')}</li>}
        {history.map((cycle) => (
          <li key={cycle.at}>
            <span className="meta">{when(cycle.at)}</span>
            {cycle.push !== null && (
              <span>
                {t('sync.pushLine', {
                  sent: cycle.push.classes + cycle.push.notebooks + cycle.push.notes,
                  accepted: cycle.push.accepted,
                  conflicted: cycle.push.conflicted,
                  forbidden: cycle.push.forbidden,
                })}
              </span>
            )}
            {cycle.pull !== null && (
              <span>
                {t('sync.pullLine', {
                  got: cycle.pull.classes + cycle.pull.notebooks + cycle.pull.notes,
                  applied: cycle.pull.applied,
                  before: cycle.pull.cursorBefore,
                  after: cycle.pull.cursorAfter,
                })}
              </span>
            )}
            {cycle.error !== null && (
              <span className="sync-error">
                {cycle.error.status ?? ''} {cycle.error.message}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
