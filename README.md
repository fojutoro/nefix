# nefix

Offline-first study notes for university students. Faculty, class, notes.
Public notes are readable and forkable.

Status: Pre-v1, phase 1 of 8.

## Stack

| Part       | Choice                                   |
|------------|------------------------------------------|
| Server     | Go, standard library `net/http`          |
| Database   | SQLite via `modernc.org/sqlite`, no cgo  |
| SQL        | Hand-written, no ORM                     |
| Client     | React 19, TypeScript, Vite, PWA          |
| Local data | IndexedDB via Dexie                      |
| Deploy     | Single static binary, systemd on the host|

## Run it

```
make dev
```

Lands in phase 1. There is nothing to run yet.

## Documentation

See [docs/](docs/) — the architecture overview, the API contract, and the
architecture decision records.

## Licence

Code is AGPL-3.0. See [LICENSE](LICENSE).

Note content published through the application is CC BY-SA 4.0, licensed
by the people who wrote it, not by this project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
