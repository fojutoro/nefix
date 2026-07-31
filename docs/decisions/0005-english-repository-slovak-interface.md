# English repository, Slovak-first interface

## Status

Accepted, 2026-07-31.

## Context

Users are almost entirely Slovak students, but the project is AGPL and
meant to be contributable by strangers. A Slovak-language codebase limits
contributors to a few million people, most of whom are not programmers,
and forces either diacritics in identifiers or mangled ASCII. Repository
language and interface language are separate questions that get
conflated. Slovak has four CLDR plural categories where English has two,
and needs locale-aware month names, so a hand-rolled translation helper
becomes wrong quickly.

## Decision

Code, comments, commit messages, documentation, ADRs, issues and pull
requests are in English, and there is one README, in English. The
interface is translated, defaulting to Slovak with English as fallback.
Translation is react-i18next with resources bundled at build time.
Plurals come from `Intl.PluralRules` through i18next and dates from
`Intl.DateTimeFormat`. No hand-rolled `t()` helper and no date library.

## Consequences

Translation keys are English identifiers, never Slovak strings used as
keys, so a missing Slovak key falls back to English rather than to blank.
No locale-prefixed URLs. Search has to be diacritic-insensitive to be
usable in Slovak — nobody types `é` into a search box — which means
normalising at write time in IndexedDB for v1, and `unicode61` with
`remove_diacritics=2` if server-side search is ever built.
