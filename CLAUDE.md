# CLAUDE.md

Rules for any AI assistant working in this repository. Not suggestions.

## The project

nefix — offline-first study notes for university students. Faculty →
class → notes. Public notes are readable and forkable. Open source,
AGPL-3.0, meant to be contributable by strangers.

## Hard constraints

- Server: Go, stdlib `net/http`. No web framework. Not Gin, Echo, Chi
  or Fiber.
- DB: SQLite via `modernc.org/sqlite`. Hand-written SQL. No ORM, no
  query builder. Must cross-compile static, so no cgo.
- Client: React 19 + TypeScript + Vite, as a PWA.
- IndexedDB (Dexie) is the source of truth while the app is running.
- Components never call the API. Only `web/src/sync/` knows the server
  exists.
- `docs/API.md` is the contract. An endpoint change and its doc change
  land in the same commit.
- No new dependency without being asked. Suggest it, do not install it.
- No Docker in development. The dev loop is `make dev`.
- Text only. No file uploads anywhere, including avatars.
- No CRDTs, ever. Editing someone else's note is a fork. A sync
  conflict becomes a fork.

## Database changes

- Migrations are numbered `.sql` files, forward-only, embedded in the
  binary and applied at startup inside a transaction before the HTTP
  listener binds. A failed migration is a non-zero exit.
- Never edit a migration that has been applied.
- Expand and contract. Never rename or drop a column in the same
  release that changes the code using it: add the new column, deploy
  code that writes both and reads the new one, backfill, then drop the
  old column in a later release.

## Release and deploy

- One long-lived branch: `main`. Work on a short branch, land it
  through a pull request.
- Releases are tags, never branches. `v0.4.0` is stable and goes to
  production; `v0.4.0-rc.1` is a prerelease and goes to staging.
- The host pulls. A systemd timer polls the GitHub releases API,
  verifies checksums, swaps a symlink, restarts, and rolls back if
  `/health` does not come up. GitHub holds no credentials for the host.
- `/health` reports version and commit, so the running build is
  identifiable with one request.

## How to work

- One phase at a time. Never begin the next phase.
- Before writing code, state: files to touch, database changes, and a
  concrete testable definition of done. Then wait for approval.
- Small commits, one concern each. Prefixes: feat, fix, chore, docs,
  refactor, test.
- `gofmt` and `go vet` clean before every commit.
- When done, state what you did NOT do that might be expected.

## Out of scope for v1 — refuse and cite this file

Annotation, highlighting, drawing, Apple Pencil. Comments. Any file
upload. Code execution. Tauri builds. Majors, minors, badges,
categories. Follows, feeds, notifications, likes. Password reset, email
verification. Real-time collaborative editing. Search across other
people's notes.

The author will ask for these. Say no and name the phase gate.

## Style

- Simplicity beats cleverness.
- Boring, obvious Go. No generics unless they remove real duplication.
  No interface with a single implementation.
- No comments that restate the code.
