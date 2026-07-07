# obsidian-remind

A headless daemon that reads a
[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) vault
**directly from CouchDB, read-only**, scans it for `@date` reminders written by
the companion **obsidian-now** plugin, and sends
[Pushover](https://pushover.net/) notifications when each reminder is due.

It handles reminders being added, edited, and removed over time, and never
double-notifies (even across restarts).

## How it works

```
CouchDB  --(REST: _all_docs / _bulk_get / _changes, read-only)-->  obsidian-remind  --> Pushover
```

1. **Read** - it connects to your LiveSync CouchDB and reconstructs note text
   from LiveSync's chunked documents (children + inline `eden` chunks). It only
   ever issues read requests (`GET _all_docs`, `POST _bulk_get`, `GET _changes`)
   and **never writes or deletes** - so it cannot affect your vault, unlike a
   bidirectional sync.
2. **Scan** - every note is parsed for date tokens carrying a reminder, e.g.
   `@2026-03-23~rel~r=d1` or `@2026-03-23 09:00~t12~z=America/New_York~r=m30`.
3. **Notify** - a lightweight ticker polls the `_changes` feed for edits and
   fires Pushover notifications when a reminder's computed time arrives.

### Reminder codes (`~r=`)

| Code | Meaning | Fires |
| --- | --- | --- |
| `at` | At time of event | event time |
| `m5`/`m10`/`m15`/`m30` | N minutes before | event - N min |
| `h1`/`h2` | N hours before | event - N hours |
| `day` | On day of event | 09:00 that day |
| `d1`/`d2` | N days before | 09:00, N days before |
| `w1` | 1 week before | 09:00, 7 days before |

Timezone: a token's own `~z=` zone is used if present; otherwise
`config.timezone` (or the system zone) applies. Time-based reminders (`at`,
`m*`, `h*`) only apply to dates that include a time.

## Requirements / limitations

- **Plaintext vaults only.** This reader does not support LiveSync
  **End-to-End Encryption** or **path obfuscation** (`encrypt: false` and no
  path obfuscation). Encrypted/binary content is skipped; if nothing decodes as
  text it logs a warning.
- Binary attachments (images, PDFs, `.base`, etc.) are ignored - only text notes
  are scanned.

This is the daemon half of the [obsidian-now](https://github.com/Netdex/obsidian-now)
monorepo. Date-token parsing is shared with the plugin via the
`obsidian-now-datecore` workspace package, so install/build from the **repo root**.

## Setup

```bash
# from the repo root
npm install
npm run build:daemon                                 # builds datecore + daemon
cp daemon/config.example.json daemon/config.json     # then edit it
cp daemon/.env.example daemon/.env                   # COUCHDB_PASSWORD + Pushover secrets
```

### Configuration (`config.json`)

| Key | Description |
| --- | --- |
| `couch.url` | CouchDB base URL, e.g. `https://couch.example.org`. |
| `couch.database` | Database name (the LiveSync `couchDB_DBNAME`). |
| `couch.username` / `couch.password` | CouchDB credentials (a read-only account is ideal). |
| `statePath` | Where "already notified" state is stored (default `./state.json`). |
| `timezone` | IANA zone for dates without an explicit `~z=` (default: system). |
| `tickIntervalMs` | How often changes are polled + due reminders checked (default 30000). |
| `missedGraceMs` | Reminders overdue by more than this are suppressed silently (default 24h). |
| `obsidianVault` | Optional vault name; adds an `obsidian://` deep link to notifications. |
| `pushover.token` / `pushover.user` | Pushover app token and user key. |

Secrets can be supplied via environment (`.env` or the process env) and override
the config file: `COUCHDB_PASSWORD`, `PUSHOVER_TOKEN`, `PUSHOVER_USER`.

Tip: point `couch.username`/`password` at a **read-only CouchDB account** for
defence in depth. The daemon never writes, but a read-only credential guarantees
it - see the LiveSync docs for setting up a reader user.

## Running

```bash
# from the daemon/ directory (after build:daemon)
node dist/src/index.js -c ./config.json
node dist/src/index.js --dry-run --verbose   # log instead of send
node dist/src/index.js --once                # scan once, fire due, exit
```

### As a service

See `deploy/obsidian-remind.service` for a systemd unit template.

### Docker

**Standalone image** (build from the repo root -- the image bundles the datecore
workspace):

```bash
docker build -f daemon/Dockerfile -t obsidian-remind .
docker run -d --name obsidian-remind \
  -e COUCHDB_PASSWORD=... -e PUSHOVER_TOKEN=... -e PUSHOVER_USER=... \
  -v $PWD/docker/config.json:/config/config.json:ro \
  -v obsidian-remind-state:/state \
  obsidian-remind
```

**Docker Compose:** `docker-compose.yml` runs the prebuilt image
(`ghcr.io/netdex/obsidian-now-remind:latest`; uncomment the `build:` block to
build locally from the repo root). Edit `docker/config.json`, put secrets in
`.env`, then `docker compose up -d`. The GHCR package is private by default, so
`docker login ghcr.io` first or make it public.

## Development

```bash
npm run check   # type-check
npm test        # build + run unit tests (fire-time + chunk reassembly)
```

## Notes

- The token grammar and chunk format are mirrored from obsidian-now /
  livesync-commonlib; if those change, update `src/reminders.ts` /
  `src/couchSource.ts`.
- Notifications are best-effort at `tickIntervalMs` granularity (default 30s).
- Reminders far in the past when first seen are suppressed (see `missedGraceMs`)
  so a first run or long downtime does not produce a burst of stale alerts.
