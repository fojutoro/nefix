# deploy

Everything the VPS needs, kept here so no part of the deploy is
knowledge that lives only on one machine.

- `nefix.service` — the systemd unit.
- `nefix-update` — the updater. Manual until phase 4; there is no timer
  yet.

**The unit in this repository is the source of truth.** A change made on
the box without a matching commit here is a bug, not a hotfix. The next
person to reinstall from this directory will silently undo it.

## Installing the unit

```
cp deploy/nefix.service /etc/systemd/system/nefix.service
systemctl daemon-reload
systemctl enable --now nefix
```

Re-run all three after any change to the unit; `daemon-reload` alone
does not restart a running service.

## Directory layout

```
/opt/nefix/
  releases/<tag>/   unpacked release, one directory per tag
  current           symlink to the live releases/<tag>
  data/             SQLite database
  backups/          pre-deploy database copies
```

`nefix-update` unpacks into `releases/<tag>/`, repoints `current`, and
restarts. Rollback is repointing `current` at the previous target, which
is why a release directory is never modified in place and why the
updater keeps the newest `KEEP` of them.

The database lives in `data/`, outside any release directory, for two
reasons. A release directory is disposable — pruning the oldest release
would delete the database with it. And `ProtectSystem=strict` in the
unit makes the filesystem read-only except for `ReadWritePaths`, which
lists `/opt/nefix/data` and nothing else; the database cannot be written
anywhere else even if configured to be.
