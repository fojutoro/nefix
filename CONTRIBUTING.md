# Contributing

## Ground rules

Components never call the API. Only code under `web/src/sync/` knows the
server exists; everything else reads and writes IndexedDB. A pull request
that puts a `fetch` call in a component will be asked to move it.

`docs/API.md` is the contract. A change to an endpoint and the change to
its documentation land in the same commit, not in a follow-up.

No new dependency without an issue first. This applies to both sides, Go
and npm. Open an issue saying what the dependency is for and what the
alternative without it looks like, and wait for an answer before adding
it.

## Style

The server is Go using the standard library, including `net/http` for
routing. No web framework. SQL is hand-written; no ORM and no query
builder.

Simplicity beats cleverness. If a change makes the code harder for a
stranger to read, it loses, even when it is shorter or faster. This obviously has a middle ground...

## Branching

`main` is the only long-lived branch. Work on a short branch and open a
pull request against `main`. Releases are tags; contributors never tag.

## Commits and pull requests

One concern per commit. Use conventional prefixes: feat, fix, chore,
docs, refactor, test. A pull request describes what changed and why the
change is wanted; the diff already says how.

## Licensing

Contributions are licensed AGPL-3.0, the same as the rest of the code.
There is no CLA to sign. Note content published through the application
is licensed CC BY-SA 4.0 by its authors, which is a separate thing from
the licence on the code.

## What not to send

Read the out-of-scope list in [CLAUDE.md](CLAUDE.md) before starting
anything sizeable. Work on something named there will be closed
regardless of how good it is, because it is waiting on a phase gate
rather than on an implementation.

## Local setup

See README — filled in during phase 1.
