# Releases are tags, not branches

## Status

Accepted, 2026-07-30.

## Context

A `prod` branch would only ever fast-forward commits that already exist
on `main`, so it carries no information a tag does not, while introducing
a second history that can drift when a hotfix lands on one side.

## Decision

`main` is the only long-lived branch. `v*` tags are releases; `-rc.N`
suffixes are prereleases for staging.

## Consequences

The running version has a name rather than a SHA. Rollback redeploys an
artifact that still exists. A `prod` branch would become worth
reconsidering only with several contributors merging at different rates.
