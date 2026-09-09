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

## CSRF

`SameSite=Lax` blocks the realistic cross-site POST, but it is one layer
and does not cover every browser or every navigation, so there is a
second.

Register and login set a second cookie, `nefix_csrf`, alongside the
session, with the same `SameSite`, `Path` and `Secure` attributes. It is
**not** `HttpOnly`: the client reads it and echoes it back, which is the
one thing a cross-site request cannot do.

Every state-changing request — `POST`, `PUT`, `PATCH`, `DELETE` — must
carry that value in an `X-CSRF-Token` header. A request whose header is
missing or does not match the session is 403. `GET` and `HEAD` are never
checked.

`POST /register` and `POST /login` are exempt. They run before there is a
session, so there is nothing to protect, and requiring a token would make
the first request of a browser's life impossible. `POST /logout` is not
exempt. A request carrying no valid session is not checked either, for
the same reason the two exempt endpoints are not, which is what keeps
logout idempotent for a caller with no cookie.

The token is derived from the session token and never stored, so a leaked
database yields neither half. The cookie is re-set on any authenticated
request that arrives without it, so a session that predates this scheme
keeps working rather than being logged out.

## Rate limiting

`POST /register` and `POST /login` are limited to 10 requests per minute
per client, from a bucket that holds 10. No other endpoint is limited.
The ceiling is low because each attempt runs argon2, which costs about
70ms and allocates 64 MiB: a few dozen at once is a memory problem before
it is a credential one.

Over the limit is 429 with `Retry-After` in whole seconds.

The client is the leftmost `X-Forwarded-For` entry when the request
arrives from loopback, where nginx sits, and the peer address otherwise.
The header is client-supplied, so trusting it from anywhere else would let
anyone mint a fresh bucket per request.

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
| POST   | `/api/v1/sync/push` | session | send local changes to the server   |
| GET    | `/api/v1/sync/pull` | session | fetch changes since a cursor       |

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
| 429 | error | over the rate limit; `Retry-After` in seconds |
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
| 429 | error | over the rate limit; `Retry-After` in seconds |
| 500 | error | the database or the session failed |

An unknown address and a wrong password return the same status and the
same message. They also take the same time: an unknown address is still
verified against a dummy hash, so the response cannot be timed to tell
whether an account exists.

If the stored hash used older parameters it is upgraded in place on a
successful sign-in. A failure there is logged and does not fail the
request, since the password was already correct.

### POST /api/v1/logout

No request body. Deletes the session and clears both cookies.

| Status | Body | When |
|--------|------|------|
| 204 | none | no session, or a session with a matching `X-CSRF-Token` |
| 403 | error | a valid session without a matching `X-CSRF-Token` |

Idempotent for a caller with no session: logging out with no cookie, an
expired session or a garbage token is still 204, because there is nothing
to protect and no state in which that logout can fail. A caller that does
hold a session is making a state-changing request like any other and needs
the header.

### GET /api/v1/me

No request body.

| Status | Body | When |
|--------|------|------|
| 200 | user object | valid session |
| 401 | error | `authentication required` |

## Sync

Two endpoints, both requiring a session. A client pushes what it has
changed and pulls what it has not seen. The server stores classes,
notebooks and notes; it does not decide what any of them should say.

A class contains notebooks and a notebook contains notes, but neither
containment is required. A notebook may exist without a class, and a note
without a notebook — an unfiled note is a real case and must not require
setting anything up first.

### The three objects

Every id is a UUIDv7 minted by the client. The server never generates one:
a class, notebook or note has to be creatable offline with no round trip,
so the id exists before the server has heard of the row. The server
validates the shape and nothing more.

`version` and `seq` are the server's on all three. A client sends the
`version` it last saw and never invents one; `seq` it only ever reads.

The class object:

```json
{ "id": "0192f0b1-3c4d-7e8f-9a0b-1c2d3e4f5a6b",
  "name": "Diskrétna matematika", "code": "1-AIN-101",
  "colour": "#3355ff", "semester": "2026Z",
  "archived_at": null, "version": 3, "seq": 12,
  "created_at": "2026-08-05T09:30:00Z", "updated_at": "2026-08-05T11:02:00Z",
  "deleted_at": null }
```

`code`, `colour` and `semester` are free text and may be null. `semester`
is a string on the class, not a table of its own.

`archived_at` is not `deleted_at`. A class is archived, never
hard-deleted: its notebooks and notes stay intact and reachable, and the
row keeps coming back from a pull. A semester's notes are exactly what
someone wants back a year later.

The notebook object:

```json
{ "id": "0192f0c1-3c4d-7e8f-9a0b-1c2d3e4f5a6b",
  "class_id": "0192f0b1-3c4d-7e8f-9a0b-1c2d3e4f5a6b",
  "name": "Prednášky", "is_general": true,
  "version": 1, "seq": 13,
  "created_at": "2026-08-05T09:30:00Z", "updated_at": "2026-08-05T09:30:00Z",
  "deleted_at": null }
```

`class_id` may be null, and may name a class the server has not been given
yet: a client syncing out of order can legitimately send a notebook before
its class, and that is not an error. Nothing resolves it server-side.

`is_general` marks the notebook created alongside its class, so a new
class is something you can type in immediately. It is renameable but not
deletable, and that rule is the client's: neither the schema nor this API
enforces it.

The note object:

```json
{ "id": "0192f0a1-3c4d-7e8f-9a0b-1c2d3e4f5a6b", "class_id": null,
  "notebook_id": "0192f0c1-3c4d-7e8f-9a0b-1c2d3e4f5a6b",
  "title": "Diskrétna matematika", "body_md": "# Množiny",
  "visibility": "private", "forked_from_id": null,
  "version": 3, "seq": 14,
  "created_at": "2026-08-05T09:30:00Z", "updated_at": "2026-08-05T11:02:00Z",
  "deleted_at": null }
```

`notebook_id` is the note's home. Null is an unfiled note. Like
`class_id` on a notebook it may name a notebook the server has not seen.

`class_id` on a note is **vestigial and must always be null**. It is an
integer, it predates client-minted ids, and nothing writes it any more;
membership is `notebook_id`. It stays on the wire for one release under
expand and contract, and both the field and the column are dropped in the
next. Do not start using it.

`visibility` is `private`, `faculty` or `public`. `faculty` currently
means readable by its author and nobody else, because `users.faculty_id`
is always NULL until faculty assignment exists and so no reader can
match. That is the intended behaviour rather than a gap.

### Why the cursor is a sequence and not a timestamp

`seq` is a per-user counter, incremented inside the same transaction
that writes the row. A pull asks for everything above a cursor, and the
cursor is the highest `seq` the client has seen.

A timestamp cursor loses rows. Timestamps have finite resolution — this
schema stores whole seconds — so two rows written close together can
carry the same one. A client that pulls, receives both, and sets its
cursor to that timestamp will ask for `> t` next time and never see
either again; a client that asks for `>= t` re-downloads on every sync,
for ever. Neither is fixable at the edges, and the failure is silent:
the row is simply never mentioned again, and nothing reports an error.
A counter cannot collide, so the question does not arise.

### One cursor for all three types

There is one counter, `users.last_seq`, and one cursor. A class, a
notebook and a note written in that order take seqs 1, 2 and 3, and a
pull returns whatever changed above the cursor whatever type it is.

Two cursors would let a client hold a consistent view of its notes and a
stale one of the notebooks those notes sit in.

### POST /api/v1/sync/push

```json
{ "classes": [
    { "id": "0192f0b1-…", "name": "Diskrétna matematika",
      "code": "1-AIN-101", "colour": "#3355ff", "semester": "2026Z",
      "archived_at": null, "version": 0, "deleted_at": null }
  ],
  "notebooks": [
    { "id": "0192f0c1-…", "class_id": "0192f0b1-…", "name": "Prednášky",
      "is_general": true, "version": 0, "deleted_at": null }
  ],
  "notes": [
    { "id": "0192f0a1-…", "class_id": null, "notebook_id": "0192f0c1-…",
      "title": "Diskrétna matematika", "body_md": "# Množiny",
      "visibility": "private", "forked_from_id": null,
      "version": 2, "deleted_at": null }
  ] }
```

Three named arrays, not one list with a `type` discriminator. Each kind
has different fields, and a tagged union on the wire would mean decoding
the body twice. Any array may be absent or empty.

`version` is the version the client last saw, and `0` for a row the
server has never had. `deleted_at` is the client's own timestamp,
returned unchanged: a delete is a row like any other, and a soft delete
has to reach the other device or the row stays there.

**The arrays are applied in the order they are listed: classes, then
notebooks, then notes.** A client creating a class and its general
notebook in one gesture pushes both in one request, and dependency order
means the server never briefly holds a notebook whose class it has not
seen. The order also decides the seqs, so a pull replays the three in the
order they were created.

At most 100 classes, 100 notebooks and 100 notes — three separate limits,
each checked on its own array — and 1 MB for the whole body. A larger
batch is 413 and the client splits it. The byte ceiling is the real
limit; the counts keep one array from monopolising it.

Each row is processed in its own transaction, so one conflict does not
roll back its neighbours. The response reports every row in the order it
was applied, which is the order above rather than the order within the
request body:

```json
{ "results": [
  { "id": "0192f0b1-…", "kind": "class",    "status": "accepted", "class": { } },
  { "id": "0192f0c1-…", "kind": "notebook", "status": "conflict", "notebook": { } },
  { "id": "0192f0a1-…", "kind": "note",     "status": "forbidden" }
] }
```

`kind` is `class`, `notebook` or `note` and says which local store the
result refers to. Ids are unique across the three, but a client still has
to know which table to write, and inferring it from which field came back
populated breaks on `forbidden`, which carries no row at all.

The accepted or conflicting row travels in the field named by `kind`:
`class`, `notebook` or `note`.

| Status | Meaning |
|--------|---------|
| `accepted` | written. The row is the stored copy, with its new `version` and `seq` |
| `conflict` | the sent `version` is not the stored one. Nothing was written. The row is the server's copy, so resolving costs no second request |
| `forbidden` | the id belongs to another user. Nothing was written and no row is returned |

A conflict is not resolved here. The server never merges and never forks
on its own: it reports what it holds and the client decides. It does not
decide differently per type either — that a client forks a conflicted
note and takes the server's copy of a conflicted class or notebook is the
client's rule, not this endpoint's.

| Status | Body | When |
|--------|------|------|
| 200 | results | the batch was processed, whatever each row's outcome |
| 400 | error | a row in any array is malformed: a bad id, a `class_id` or `notebook_id` that is not a UUID, an unknown `visibility`, a title or name over 200 characters, a negative `version`, or an `archived_at` or `deleted_at` that is not RFC 3339. Nothing is written; the message names the row |
| 401 | error | `authentication required` |
| 403 | error | missing or invalid `X-CSRF-Token` |
| 413 | error | over 100 rows in any one array, or over 1 MB; the message names the array |
| 500 | error | the database failed |

Validation runs over all three arrays before the first write, so a batch
the server refuses leaves no half of itself behind. A malformed notebook
refuses the classes and notes sent beside it.

### GET /api/v1/sync/pull

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `since` | `0` | return rows with `seq` greater than this. `0` is a fresh device and means everything |
| `limit` | `100` | at most 500; a larger value is clamped rather than refused. It is the size of the whole page, not of each array |

```json
{ "classes": [ ], "notebooks": [ ], "notes": [ ], "cursor": 42,
  "has_more": false }
```

Returns only the caller's own rows, in `seq` order within each array,
soft-deleted and archived ones included. `cursor` is the highest `seq` in
the page across all three arrays, or the `since` that was sent when the
page is empty — an empty pull must not rewind a client to the start of
its history. `has_more` is true when any type had rows left over, and
means call again with the new cursor.

**A page can be entirely one type.** The three arrays are one ordered
stream cut up by table, and a page is the `limit` lowest seqs in that
stream, whatever mixture that turns out to be: rename six notebooks and
the next page is six notebooks, even though classes and notes have rows
above the cursor too. That is not a gap — the cursor is a position in the
stream and which table a row came from is incidental to it. The rows that
did not fit are above the cursor and arrive on the next call, in order.

A client must therefore apply a page as a whole and store the cursor once,
after all three arrays are written. Storing it per array, or paging each
type separately, reintroduces exactly the split view the single cursor
exists to prevent.

| Status | Body | When |
|--------|------|------|
| 200 | classes, notebooks, notes, cursor, has_more | always, including an empty page |
| 400 | error | `since` or `limit` is not a non-negative integer |
| 401 | error | `authentication required` |
| 500 | error | the database failed |
