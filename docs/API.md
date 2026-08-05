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

JSON, at most 8 KB, except `POST /api/v1/sync/push`, which carries a
batch and is capped at 1 MB. Unknown fields are rejected rather than
ignored, so a typo in a field name fails loudly instead of silently
doing nothing. A body that is malformed, or not JSON, is 400; one over
its limit is 413.

Timestamps on the wire are RFC 3339 in UTC, `2026-08-05T09:30:00Z`.
They are stored in SQLite's `datetime('now')` form and converted at the
boundary, so a value that does not parse is a 400 rather than a string
the database cannot compare.

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
| POST   | `/api/v1/sync/push` | session | send local notes to the server     |
| GET    | `/api/v1/sync/pull` | session | fetch notes changed since a cursor |

Every `/api/` response carries `Cache-Control: no-store` and
`Vary: Cookie`. IndexedDB is the client's source of truth, so a cached
API response is always a chance to hand a client something older than
what it already holds. The client's service worker declares these
NetworkOnly, but that binds only the service worker: the browser's own
HTTP cache sits underneath it, and proxies sit above it. The server
saying so binds all of them.

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

## Sync

Two endpoints, both requiring a session. A client pushes what it has
changed and pulls what it has not seen. The server stores notes; it does
not decide what a note should say.

### The note object

Returned by both endpoints:

```json
{ "id": "0192f0a1-3c4d-7e8f-9a0b-1c2d3e4f5a6b", "class_id": null,
  "title": "Diskrétna matematika", "body_md": "# Množiny",
  "visibility": "private", "forked_from_id": null,
  "version": 3, "seq": 12,
  "created_at": "2026-08-05T09:30:00Z", "updated_at": "2026-08-05T11:02:00Z",
  "deleted_at": null }
```

`id` is a UUIDv7 minted by the client. The server never generates one:
a note has to be creatable offline with no round trip, so the id exists
before the server has heard of the note. The server validates the shape
and nothing more.

`visibility` is `private`, `faculty` or `public`. `faculty` currently
means readable by its author and nobody else, because `users.faculty_id`
is always NULL until faculty assignment exists and so no reader can
match. That is the intended behaviour rather than a gap.

`version` and `seq` are the server's. A client sends the `version` it
last saw and never invents one; `seq` it only ever reads.

### Why the cursor is a sequence and not a timestamp

`seq` is a per-user counter, incremented inside the same transaction
that writes the note. A pull asks for everything above a cursor, and the
cursor is the highest `seq` the client has seen.

A timestamp cursor loses notes. Timestamps have finite resolution — this
schema stores whole seconds — so two notes written close together can
carry the same one. A client that pulls, receives both, and sets its
cursor to that timestamp will ask for `> t` next time and never see
either again; a client that asks for `>= t` re-downloads on every sync,
for ever. Neither is fixable at the edges, and the failure is silent:
the note is simply never mentioned again, and nothing reports an error.
A counter cannot collide, so the question does not arise.

### POST /api/v1/sync/push

```json
{ "notes": [
  { "id": "0192f0a1-3c4d-7e8f-9a0b-1c2d3e4f5a6b", "class_id": null,
    "title": "Diskrétna matematika", "body_md": "# Množiny",
    "visibility": "private", "forked_from_id": null,
    "version": 2, "deleted_at": null }
] }
```

At most 100 notes and 1 MB. A larger batch is 413 and the client splits
it. `version` is the version the client last saw, and `0` for a note the
server has never had. `deleted_at` is the client's own timestamp,
returned unchanged: a delete is a note like any other, and a soft delete
has to reach the other device or the note stays there.

Each note is processed in its own transaction, so one conflict does not
roll back its neighbours. The response reports every note in the order
it was sent:

```json
{ "results": [
  { "id": "0192f0a1-…", "status": "accepted", "note": { } },
  { "id": "0192f0a2-…", "status": "conflict", "note": { } },
  { "id": "0192f0a3-…", "status": "forbidden" }
] }
```

| Status | Meaning |
|--------|---------|
| `accepted` | written. `note` is the stored copy, with its new `version` and `seq` |
| `conflict` | the sent `version` is not the stored one. Nothing was written. `note` is the server's copy, so resolving costs no second request |
| `forbidden` | the id belongs to another user. Nothing was written and no `note` is returned |

A conflict is not resolved here. The server never merges and never
forks on its own: it reports what it holds and the client decides. A
`forbidden` result carries no note, so a client that guessed an id
learns only that it may not write there.

| Status | Body | When |
|--------|------|------|
| 200 | results | the batch was processed, whatever each note's outcome |
| 400 | error | a note is malformed: a bad id, an unknown `visibility`, a title over 200 characters, a negative `version`, or a `deleted_at` that is not RFC 3339. Nothing is written; the message names the note |
| 401 | error | `authentication required` |
| 413 | error | over 100 notes or over 1 MB |
| 500 | error | the database failed |

Validation happens before the first write, so a batch the server refuses
leaves no half of itself behind.

### GET /api/v1/sync/pull

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `since` | `0` | return notes with `seq` greater than this. `0` is a fresh device and means everything |
| `limit` | `100` | at most 500; a larger value is clamped rather than refused |

```json
{ "notes": [ ], "cursor": 42, "has_more": false }
```

Returns only the caller's own notes, in `seq` order, soft-deleted ones
included. `cursor` is the highest `seq` in the page, or the `since` that
was sent when the page is empty — an empty pull must not rewind a client
to the start of its history. `has_more` true means call again with the
new cursor; a client can page through a history larger than its memory.

| Status | Body | When |
|--------|------|------|
| 200 | notes, cursor, has_more | always, including an empty page |
| 400 | error | `since` or `limit` is not a non-negative integer |
| 401 | error | `authentication required` |
| 500 | error | the database failed |
