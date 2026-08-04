# API

The contract. Endpoints are added here in the same commit that adds them
to the server.

## Base path

All endpoints live under `/api/v1/`, except `/health`, which sits at the
root because the deploy checks it before anything is versioned. The base
URL is configurable on the client, so the frontend does not assume it is
served from the same origin as the API.

## Authentication

An httpOnly cookie session. There is no token in JavaScript-readable
storage and no `Authorization` header.

The cookie is `nefix_session`, with `HttpOnly`, `SameSite=Lax`,
`Path=/`, and `Secure` unless `NEFIX_SECURE_COOKIES=false`. Its value is
an opaque random token; only a hash of it is stored server-side.

Expiry slides: a session lasts 30 days, and a request made with fewer
than 15 days remaining extends it back to 30 and sends a refreshed
cookie. A request with more than half the lifetime left does not write,
so reads stay reads.

`POST /register` and `POST /login` set the cookie. `POST /logout` clears
it. Every other endpoint accepts it and never sets it, apart from the
sliding refresh above.

## Request bodies

JSON, at most 8 KB. Unknown fields are rejected rather than ignored, so
a typo in a field name fails loudly instead of silently doing nothing.
A body that is malformed, or not JSON, is 400; one over 8 KB is 413.

## Errors

An error is the HTTP status plus a JSON body:

```json
{ "error": "human message" }
```

The message is for a person to read. Clients branch on the status, never
on the string.

## Endpoints

| Method | Path                | Auth    | Description                        |
|--------|---------------------|---------|------------------------------------|
| GET    | `/health`           | public  | status, version and commit         |
| POST   | `/api/v1/register`  | public  | create an account and sign in      |
| POST   | `/api/v1/login`     | public  | sign in                            |
| POST   | `/api/v1/logout`    | public  | end the session                    |
| GET    | `/api/v1/me`        | session | the signed-in user                 |

The user object, returned by register, login and me. The password hash
has no field and is never sent:

```json
{ "id": 1, "username": "jozef", "display_name": "Jozef Novák",
  "email": "jozef@example.sk", "role": "student" }
```

`role` is one of `student`, `teacher`, `admin`. Nothing can change it
from `student` yet.

### GET /health

200, `Content-Type: application/json`:

```json
{ "status": "ok", "version": "v0.1.0", "commit": "abc1234" }
```

`version` and `commit` are set at build time with `-ldflags`. They are
`dev` and `none` in a build that did not set them.

### POST /api/v1/register

```json
{ "username": "jozef", "display_name": "Jozef Novák",
  "email": "jozef@example.sk", "password": "at least eight bytes" }
```

`username` is lowercased and trimmed, 3–32 characters, and may contain
only `a-z`, `0-9`, `_` and `-`. `display_name` is trimmed, 1–64
characters. `email` is lowercased and trimmed, at most 254 characters,
and must hold exactly one `@` with text on both sides. `password` is
8–128 **bytes**; the ceiling is deliberate, because each hash allocates
64 MiB and an unbounded password is a denial of service.

Registration signs you in: the response sets the session cookie.

| Status | Body | When |
|--------|------|------|
| 201 | user object | created |
| 400 | error | a validation rule failed; the message names which |
| 409 | error | `username or email already taken` |
| 413 | error | body over 8 KB |
| 500 | error | hashing, the database, or the session failed |

The 409 never says which of the two collided. Saying so would confirm
whether an address is registered.

### POST /api/v1/login

```json
{ "email": "jozef@example.sk", "password": "at least eight bytes" }
```

| Status | Body | When |
|--------|------|------|
| 200 | user object | signed in, cookie set |
| 400 | error | malformed body |
| 401 | error | `wrong email or password` |
| 413 | error | body over 8 KB |
| 500 | error | the database or the session failed |

An unknown address and a wrong password return the same status and the
same message. They also take the same time: an unknown address is still
verified against a dummy hash, so the response cannot be timed to tell
whether an account exists.

If the stored hash used older parameters it is upgraded in place on a
successful sign-in. A failure there is logged and does not fail the
request, since the password was already correct.

### POST /api/v1/logout

No request body. Deletes the session and clears the cookie.

| Status | Body | When |
|--------|------|------|
| 204 | none | always |

Idempotent. Logging out with no cookie, an expired session or a garbage
token is still 204: there is no state in which logging out fails.

### GET /api/v1/me

No request body.

| Status | Body | When |
|--------|------|------|
| 200 | user object | valid session |
| 401 | error | `authentication required` |
