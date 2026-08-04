import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchHealth } from './health.ts'

export default function App() {
  const { t, i18n } = useTranslation()
  const [version, setVersion] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal)
      .then((health) => setVersion(health.version))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [])

  const serverVersion =
    version ?? (failed ? t('health.unavailable') : t('health.loading'))

  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>{t('app.tagline')}</p>
      <dl>
        <dt>{t('app.language')}</dt>
        <dd>{i18n.language}</dd>
        <dt>{t('health.label')}</dt>
        <dd>{serverVersion}</dd>
      </dl>
      <button
        type="button"
        onClick={() => void i18n.changeLanguage(i18n.language === 'sk' ? 'en' : 'sk')}
      >
        {t('app.switchLanguage')}
      </button>
    </main>
  )
}
