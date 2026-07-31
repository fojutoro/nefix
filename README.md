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
git clone https://github.com/fojutoro/nefix.git
cd nefix
make dev
```

Then open <http://localhost:8080/health>.

## Development

- `make dev` — run the server with version and commit baked in
- `make test` — run the server tests
- `make build` — build a static binary into `bin/nefix`
- `make lint` — gofmt, then `go vet`, then staticcheck
- `make clean` — remove `bin/`

## Documentation

See [docs/](docs/) — the architecture overview, the API contract, and the
architecture decision records.

## Licence

Code is AGPL-3.0. See [LICENSE](LICENSE).

Note content published through the application is CC BY-SA 4.0, licensed
by the people who wrote it, not by this project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
