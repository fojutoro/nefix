# Pull-based deployment

## Status

Accepted, 2026-07-30.

## Context

A webhook receiver would mean a public endpoint able to trigger a privileged binary swap, a shared secret to manage, and signature verification to get right; it also cannot catch up on a delivery missed while the host was down. A self-hosted Actions runner on a public repository would let a stranger's pull request execute code on the host. SSH from Actions would require a deploy key in GitHub and inbound SSH access.

## Decision

The host polls the GitHub releases API on a systemd timer and updates itself.

## Consequences

No secrets and no inbound access; the deploy is self-healing because a version mismatch is corrected on the next tick. Costs up to five minutes of latency, and the deploy log lives in journald rather than the Actions UI. `systemctl start nefix-update` triggers it immediately when needed.
