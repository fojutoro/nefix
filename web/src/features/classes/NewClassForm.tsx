import { useState } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  className: string
  onCreate: (name: string) => void
  onCancel: () => void
}

// One form for the rail and for Home, because the two must behave identically
// and a copy would drift the first time either is touched.
export default function NewClassForm({ className, onCreate, onCancel }: Props) {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = name.trim()
        // An empty name does nothing. A class is named after something that
        // exists, so there is no "Untitled" class to create.
        if (trimmed === '') return
        setName('')
        onCreate(trimmed)
      }}
    >
      <input
        autoFocus
        value={name}
        aria-label={t('rail.className')}
        placeholder={t('rail.className')}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          // Kept off the window listener that closes the drawer: while this
          // field has focus, Escape means cancel the row.
          event.stopPropagation()
          onCancel()
        }}
      />
    </form>
  )
}
