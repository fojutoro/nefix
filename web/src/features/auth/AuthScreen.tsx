import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  OfflineError,
  ServerError,
  UnauthenticatedError,
} from '../../sync/api.ts'
import { login, register, type User } from '../../sync/auth.ts'

const USERNAME = /^[a-z0-9_-]{3,32}$/

// The server counts bytes, because each hash allocates 64 MiB and the ceiling
// is what stops an unbounded password becoming a denial of service. A Slovak
// password is shorter in characters than in bytes, so counting characters
// here would pass something the server then rejects.
const bytes = (text: string) => new TextEncoder().encode(text).length

function messageFor(failure: unknown, t: TFunction): string {
  if (failure instanceof OfflineError) return t('auth.offline')
  // The server's 409 never says whether it was the username or the email,
  // because saying so confirms whether an address is registered. Guessing
  // here would undo that.
  if (failure instanceof ServerError && failure.status === 409) {
    return t('auth.taken')
  }
  // A 400 names the rule that failed and a 401 is "wrong email or password".
  // Both are written for a person to read, so they are shown as they came.
  if (failure instanceof ServerError || failure instanceof UnauthenticatedError) {
    return failure.message
  }
  return t('auth.failed')
}

type Props = {
  onSignedIn: (user: User) => void
}

export default function AuthScreen({ onSignedIn }: Props) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The server's own rules, checked here so the user is told before a round
  // trip rather than after one. The server checks them again regardless:
  // this is a courtesy, not the enforcement.
  const problem = (): string | null => {
    const [local, domain, ...rest] = email.trim().toLowerCase().split('@')
    if (rest.length > 0 || !local || !domain) return t('auth.emailRule')
    if (bytes(password) < 8 || bytes(password) > 128) {
      return t('auth.passwordRule')
    }
    if (!creating) return null
    if (!USERNAME.test(username.trim().toLowerCase())) {
      return t('auth.usernameRule')
    }
    const name = displayName.trim()
    if (name.length < 1 || name.length > 64) return t('auth.displayNameRule')
    return null
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const found = problem()
    if (found !== null) {
      setError(found)
      return
    }
    setError(null)
    setBusy(true)
    try {
      const address = email.trim().toLowerCase()
      const user = creating
        ? await register({
            username: username.trim().toLowerCase(),
            displayName: displayName.trim(),
            email: address,
            password,
          })
        : await login(address, password)
      onSignedIn(user)
    } catch (failure) {
      setError(messageFor(failure, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <h1>{t('app.title')}</h1>
      <p className="tagline">{t('app.tagline')}</p>
      <h2>{creating ? t('auth.registerHeading') : t('auth.signInHeading')}</h2>
      {/* noValidate: the input types stay, so mobile keyboards and password
          managers still behave, but the messages the user reads are the
          translated ones above and not the browser's. */}
      <form onSubmit={(event) => void submit(event)} noValidate>
        {creating && (
          <>
            <label htmlFor="auth-username">{t('auth.username')}</label>
            <input
              id="auth-username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <label htmlFor="auth-display-name">{t('auth.displayName')}</label>
            <input
              id="auth-display-name"
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </>
        )}
        <label htmlFor="auth-email">{t('auth.email')}</label>
        <input
          id="auth-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="auth-password">{t('auth.password')}</label>
        <input
          id="auth-password"
          type="password"
          autoComplete={creating ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error !== null && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy
            ? t('auth.working')
            : creating
              ? t('auth.submitRegister')
              : t('auth.submitSignIn')}
        </button>
      </form>
      <button
        type="button"
        className="link"
        onClick={() => {
          setCreating(!creating)
          setError(null)
        }}
      >
        {creating ? t('auth.toSignIn') : t('auth.toRegister')}
      </button>
    </main>
  )
}
