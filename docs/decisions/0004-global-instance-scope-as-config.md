# Global instance, scope as configuration

## Status

Accepted, 2026-07-30.

## Context

Global hosting, university hosting and faculty hosting are not three data
models. Global is the superset; the narrower cases are a global instance
with creation and visibility restricted by configuration. Building narrow
first would require unpicking an implicit faculty filter from every query
to widen it later.

## Decision

The instance is global. A user's faculty is an attribute that determines
defaults, class creation and teacher endorsement authority — never what
they can read. Public is public across the whole instance. Narrower
deployments arrive in v2 as `NEFIX_SCOPE=global|university|faculty` plus
a scope id, adding query filters and registration limits but no tables.

## Consequences

`universities` becomes a table and `faculties` gains `university_id`, so
cross-university browsing has something to join against. Instances never
federate — an isolated deployment stays isolated. Cross-university subject
linking is out of scope for v1 and, if built, is free-text search over
class names and note titles before it is ever a curated subject layer.
