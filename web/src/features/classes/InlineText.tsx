import { useState } from 'react'

type Props = {
  value: string
  // Names the field while editing and the control before it, so the button
  // that shows a class code still says what pressing it does.
  label: string
  // Stands in when there is no value yet, which is how an absent code offers
  // itself for filling in.
  placeholder: string
  className?: string
  onCommit: (value: string) => void
}

// The same gesture as creating a class: the thing becomes a field in place,
// Enter commits, Escape cancels. No modal, because renaming a class is not a
// decision that deserves one.
export default function InlineText({
  value,
  label,
  placeholder,
  className,
  onCommit,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)

  const commit = () => {
    setEditing(false)
    const trimmed = text.trim()
    // Unchanged is not a change: a write here would mark the row dirty and
    // send it, for someone having opened the field and thought better of it.
    if (trimmed !== value) onCommit(trimmed)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={className}
        aria-label={value === '' ? placeholder : label}
        onClick={() => {
          setText(value)
          setEditing(true)
        }}
      >
        {value === '' ? placeholder : value}
      </button>
    )
  }

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        commit()
      }}
    >
      <input
        autoFocus
        value={text}
        aria-label={label}
        onChange={(event) => setText(event.target.value)}
        // Committing rather than cancelling, because clicking elsewhere is
        // not how anyone says "throw that away".
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          // Kept off the window listener that leaves the editor and closes
          // the drawer: here Escape means abandon this edit.
          event.stopPropagation()
          setEditing(false)
        }}
      />
    </form>
  )
}
