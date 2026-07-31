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
stranger to read, it loses, even when it is shorter or faster.

That is a judgement, not a rule to apply mechanically. Some complexity is
essential, and simple does not mean naive — a correct algorithm that
needs a paragraph of explanation can be the simple option, and three
copies of the same logic can be the complicated one. The working test is
whether someone who has never opened the file can follow it. Where the
answer is genuinely unclear, say so in the pull request and it gets
discussed rather than settled by assertion.

## Local setup

Go 1.26 or newer; the exact minimum is the `go` line in
`server/go.mod`. Nothing else, and no Docker — see
[ADR 0001](docs/decisions/0001-no-docker-in-development.md).
```
git clone https://github.com/fojutoro/nefix.git
cd nefix
make dev
```
Then open http://localhost:8080/health.

Other targets: `make test`, `make lint`, `make build`, `make clean`.
Running `make` with no target lists them.

## Branching

`main` is the only long-lived branch, and it is protected: no direct
pushes, no force pushes, no deletion. Every change reaches it through a
pull request, including the maintainer's.

If you have push access, work on a short branch in this repository. If
you do not, fork it and open the pull request from your fork. Either way
the branch is deleted once it merges.

Releases are tags, never branches, and only the maintainer tags.

## Before you open a pull request
```
make lint
make test
```
CI runs those same targets, so a clean run locally is a good predictor
of a green run on the pull request. `make lint` covers gofmt, `go vet`
and staticcheck; the gofmt step fails on any file that is not formatted,
so run `gofmt -w` on anything it names.

## Pull requests

Merges are squashed, so a merged pull request becomes exactly one commit
on `main`. That has two consequences worth knowing:

The pull request title becomes that commit message, so it carries the
conventional prefix — `feat: fork a public note`, not `Fixes`. Release
changelogs are generated from those messages.

Commits on your branch are working notes and disappear on merge. Keep
them small anyway, one concern each, because that is what makes the
review readable.

One concern per pull request. Describe what changed and why it is
wanted; the diff already says how.

Two things must be true before it can merge: the `server` check passes,
and every review conversation is resolved. No approving review is
required.

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

## Getting help

Open an issue and ask. Being unsure about the setup, the structure, or
whether an idea is in scope is normal, and asking first is cheaper than
finding out in review.