import { send, UnauthenticatedError } from './api.ts'

// The user object returned by register, login and me. The password hash has
// no field on the wire, so it cannot arrive here even by accident.
export type User = {
  id: number
  username: string
  display_name: string
  email: string
  role: 'student' | 'teacher' | 'admin'
}

const posting = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export async function login(email: string, password: string): Promise<User> {
  return (await send('/api/v1/login', posting({ email, password }))) as User
}

export async function register(input: {
  username: string
  displayName: string
  email: string
  password: string
}): Promise<User> {
  // snake_case on the wire, camelCase in here: the boundary converts, so no
  // component ever has to know which side of it a name came from.
  return (await send(
    '/api/v1/register',
    posting({
      username: input.username,
      display_name: input.displayName,
      email: input.email,
      password: input.password,
    }),
  )) as User
}

export async function logout(): Promise<void> {
  await send('/api/v1/logout', { method: 'POST' })
}

// A 401 here is the answer, not a failure: it means nobody is signed in.
// Everything else is thrown, because "signed out" and "could not ask" have to
// lead to different screens — one is a wall, the other is a train.
export async function me(): Promise<User | null> {
  try {
    return (await send('/api/v1/me')) as User
  } catch (error) {
    if (error instanceof UnauthenticatedError) return null
    throw error
  }
}
