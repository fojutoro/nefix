# Architecture

## Repository layout

Target, not current state.

```
nefix/
├── server/
│   ├── cmd/nefix/            entry point
│   ├── internal/
│   │   ├── http/             handlers, routing, middleware
│   │   ├── store/            SQLite access, hand-written SQL
│   │   │   └── migrations/   numbered .sql files, embedded
│   │   └── web/dist/         copied frontend build, gitignored
│   └── go.mod
├── web/
│   ├── src/
│   │   ├── db/               Dexie schema and note CRUD
│   │   ├── features/
│   │   │   └── notes/        editor, note list, autosave
│   │   ├── i18n/             en.ts, sk.ts, bundled at build time
│   │   ├── App.tsx           the one page
│   │   ├── index.css         all of the styling
│   │   └── main.tsx          entry point
│   ├── eslint.config.js
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
└── docs/
    ├── ARCHITECTURE.md
    ├── API.md
    └── decisions/
```

## Development

Development runs two processes: the Vite dev server on 5173 and the Go server
on 8080, started by `make web-dev` and `make dev`. Vite proxies `/api` and
`/health` to `127.0.0.1:8080` so the browser sees one origin, which is what
lets session cookies work without any CORS handling on the server.

## Data flow

A component reads and writes IndexedDB through Dexie and never touches
the network. `web/src/sync/` observes local changes, pushes them to
`/api/v1/`, pulls remote changes back, and writes them into IndexedDB,
where the component sees them like any other local change. The server
writes to SQLite. Nothing skips a step: a component that wants server
data waits for sync to put it in IndexedDB, and a handler that wants
client data waits for sync to send it.

CodeMirror owns the note body and reports every change to `useAutosave`,
which debounces 500ms and also writes on unmount, on a note switch, and
when the page is hidden, because mobile Safari cannot be trusted to fire
`beforeunload`. Each write derives the title from the first line of the
body and goes to IndexedDB through `db/notes.ts`, never to the network.

## Local schema

`web/src/db/` holds one IndexedDB store, `notes`, keyed by a
client-generated UUIDv7 string, so a note can be created offline and its
ids sort by creation time. Deletes are soft: `deletedAt` is set and every
read filters it out, because a removed row cannot be told apart from one
that never existed.

## Embedding the frontend

The build copies `web/dist` into `server/internal/web/dist/`, which is
gitignored, because `go:embed` cannot reach outside its own module
directory. The result is one binary that serves both the API and the
client. Not implemented yet.

## Sync

Every synced row carries `version` and `updated_at`. A push that arrives
with a stale `version` is a conflict, and a conflict creates a fork owned
by whoever was editing. There is no merge dialog and no CRDT.

## Migrations

Numbered forward-only `.sql` files in `server/internal/store/migrations/`,
embedded into the binary from the `store` package because `go:embed` cannot
reach outside its own directory. At startup,
before the listener binds, the applied set is read from
`schema_migrations` and anything newer runs inside a transaction. A
failure exits non-zero, so a process that is listening has a schema that
matches its code. An applied migration is never edited.

## Release and deploy

| Tag             | Channel    | Environment |
| --------------- | ---------- | ----------- |
| `v0.4.0`      | stable     | production  |
| `v0.4.0-rc.1` | prerelease | staging     |

A tag triggers GoReleaser, which publishes a static linux/amd64 binary
and checksums to a GitHub Release. A systemd timer on the host polls the
releases API every five minutes, verifies the checksum, backs up the
database, unpacks to `/opt/nefix/releases/<tag>/`, repoints the
`/opt/nefix/current` symlink, restarts the unit, and polls `/health`. If
health does not come up within 30 seconds it repoints the symlink to the
previous release and restarts. The last three releases are kept. GitHub
holds no credentials for the host and never connects to it. Staging
arrives in phase 4; production only until then. None of this is
implemented yet.
