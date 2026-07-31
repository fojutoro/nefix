# Global instance, scope as configuration

## Status

Accepted, 2026-07-30. Amended 2026-07-31: institutions, not universities.

## Context

Global hosting, university hosting and faculty hosting are not three data
models. Global is the superset; the narrower cases are a global instance
with creation and visibility restricted by configuration. Building narrow
first would require unpicking an implicit faculty filter from every query
to widen it later.

Secondary schools may eventually be hosted alongside universities.
Renaming a table that foreign keys and every query reference is an
expensive migration, so the name is decided now; everything else about
secondary schools is deferred, because adding a nullable column with a
default is the cheapest migration there is.

## Decision

The instance is global. A user's faculty is an attribute that determines
defaults, class creation and teacher endorsement authority — never what
they can read. Public is public across the whole instance. Narrower
deployments arrive in v2 as `NEFIX_SCOPE=global|university|faculty` plus
a scope id, adding query filters and registration limits but no tables.

The top-level table is `institutions`, carrying a `kind` column of
`'university'` or `'secondary'`. A secondary school gets exactly one
auto-created faculty row, hidden in the interface, so that the hierarchy
stays uniform. A nullable faculty level was rejected: an optional level
grows a branch in every query, join and permission check forever, in
exchange for a case that may never occur.

## Consequences

`institutions` becomes a table and `faculties` gains `institution_id`, so
cross-institution browsing has something to join against. Instances never
federate — an isolated deployment stays isolated. Cross-university subject
linking is out of scope for v1 and, if built, is free-text search over
class names and note titles before it is ever a curated subject layer.
