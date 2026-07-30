# No Docker in development

## Status

Accepted, 2026-07-30.

## Context

The server is one static Go binary with no cgo, and the database is a
SQLite file. There is no runtime or dependency set to isolate.
Containerising the dev loop slows Vite HMR and adds bind-mount and
file-locking problems on macOS and Windows for no benefit. The host
already runs systemd, which supplies restart-on-failure, journald and
status.

## Decision

No Docker in development or deployment. A Dockerfile may be added later
purely to publish a release image.

## Consequences

`make dev` replaces `docker compose up` in the README. Cheap to reverse —
the deployable unit is the binary either way.
