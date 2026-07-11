# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An npm-workspaces monorepo with three parts that share one date-token grammar:

- **`/`** (root) - the **obsidian-now** Obsidian plugin. Type `@` to insert an
  inline date pill, Notion-style. Source in `src/`, bundles to `main.js`.
- **`packages/datecore`** - **obsidian-now-datecore**, the shared token
  grammar/parsing and formatting. Pure TypeScript, no runtime deps. The single
  source of truth for the `@date` token format.
- **`daemon/`** - **obsidian-remind**, a headless daemon that reads a
  Self-hosted LiveSync CouchDB vault read-only and sends Pushover reminders for
  `@date` tokens carrying a `~r=` reminder.

`datecore` is consumed as a **compiled** dependency (`dist/`), not via TS path
mapping, so it must be built before either consumer will type-check or bundle.
The plugin's `src/dateUtils.ts` is a one-line re-export of the package, kept so
existing `./dateUtils` imports keep working.

## Commands

All commands run from the **repo root** (the workspaces live there).

```bash
npm install

# Plugin
npm run dev       # esbuild watch -> main.js (sourcemapped, unminified)
npm run build     # build datecore, tsc type-check, production bundle to main.js

# Daemon (builds datecore first)
npm run build:daemon
npm run check -w obsidian-remind    # type-check only
npm test -w obsidian-remind         # build + node --test on dist/test/*.test.js

# A single daemon test file
npm run build -w obsidian-remind && node --test daemon/dist/test/<name>.test.js
```

The plugin has no unit tests; the daemon's tests cover fire-time computation and
LiveSync chunk reassembly. CI (`.github/workflows/ci.yml`) runs, in order:
build datecore -> daemon type-check -> daemon tests -> plugin build, then builds
and pushes the daemon Docker image.

## Releasing the plugin

`node release.mjs [x.y.z]` (via `npm run release`). It bumps `manifest.json` +
`versions.json`, builds, commits, pushes, and creates a GitHub release with the
three BRAT assets (`main.js`, `manifest.json`, `styles.css`). Requires an
authenticated `gh`. It refuses to release over a tag that already exists on
origin.

## The token format (the core abstraction)

Defined and documented in `packages/datecore/src/index.ts`. A date is stored
**canonically** so the underlying instant never drifts; display preferences ride
along as hidden `~`-suffix segments that the pill widget hides from view:

```
@2026-07-05                                    ISO
@2026-07-05~rel                                shown relative ("Monday")
@2026-07-05 09:00~full~t12                     "July 5, 2026 9:00 AM"
@2026-07-05 09:00~rel~t24~z=America/New_York   "Monday 09:00 EDT"
@[[2026-07-05]]~rel                            graph-linked ("Monday")
@[[2026-07-05]] 09:00~full~t12~r=m30           linked, timed, 30-min reminder
```

Only the date itself is optionally wrapped in an Obsidian `[[wikilink]]` (for the
graph / daily notes); the time and `~` segments stay outside the brackets.
Segments: date format (`rel`/`full`/`short`/`mdy`/`dmy`/`ymd`; `iso` = none),
time format (`t12`/`t24`), timezone (`z=<IANA>`), reminder (`r=<code>`). Relative
labels like "Today" are recomputed on render so they never go stale.

Everything hinges on `DATE_TOKEN_REGEX` and `parseToken`/`formatToken`. The
linked branch (`@[[...]]`) and unlinked branch are separate regex alternatives
so a plain `@date` inside an unrelated wikilink doesn't swallow that link's
brackets. If you change the grammar, both consumers and the daemon's
`src/couchSource.ts` chunk handling may need updating (see `daemon/README.md`).

## Plugin architecture (`src/`)

- **`main.ts`** - `NowPlugin`. Registers the editor extensions, a markdown
  post-processor for reading view, and the settings tab. Implements `PickerHost`
  (the interface in `editorExtension.ts`, kept separate to avoid a circular
  import). Owns the inline "typing session" lifecycle and pill-edit flow.
- **`editorExtension.ts`** - three CodeMirror 6 extensions:
  1. a trigger that starts a session when `@` is typed at a word boundary and
     keeps it synced as you type;
  2. a high-precedence keymap (Enter commits, Escape cancels, arrows navigate);
  3. the pill decoration that atomically replaces each token with a
     `DatePillWidget` (runs at `Prec.high` so its atomic replace beats
     Obsidian's own live-preview rendering of the inner `[[wikilink]]`).
- **`datePicker.ts`** - the floating calendar/picker UI (`DatePicker`,
  `PickerValue`). Positioned at the caret; drives `onSubmit`/`onClear`/etc.
  callbacks the plugin wires up.
- **Reading view** (`main.ts`, `decorateReadingView`) - Obsidian renders a
  linked date's `[[...]]` into an `<a>` before we see the DOM, splitting the
  token across sibling nodes; `decorateLinkedReadingView` folds those back into a
  single pill so linked and unlinked dates look identical, then a TreeWalker pass
  handles the remaining plain-text tokens.

Two code paths render pills (live editor widget and reading-view post-processor)
and must stay visually consistent; both build on `formatPill` from datecore.

## Daemon architecture (`daemon/src/`)

- **`daemon.ts`** - `ReminderDaemon`. `scanAll()` builds an in-memory index of
  reminders keyed by CouchDB doc id; a ticker polls the `_changes` feed
  (`tickIntervalMs`), updates the index, then fires due reminders. De-duplicates
  via `State` so it never double-notifies across restarts; suppresses reminders
  overdue by more than `missedGraceMs` (stale-burst guard on first run).
- **`couchSource.ts`** - read-only CouchDB access; reconstructs note text from
  LiveSync's chunked documents. **Only ever issues reads** (`_all_docs`,
  `_bulk_get`, `_changes`). Plaintext vaults only - no E2E encryption or path
  obfuscation.
- **`reminders.ts`** - wraps datecore's `parseToken`/`reminderOffset` and adds
  the **timezone-aware** fire-time computation (this is the daemon-specific bit,
  using luxon). The plugin computes fire times in local time for pill colouring
  only (`reminderFireLocal` in datecore); the daemon computes the exact instant.

See `daemon/README.md` for config, reminder-code table, Docker, and systemd.

## Conventions

- Keep source **ASCII-only** (per global instructions): no non-ASCII bytes in
  files. Use `--` not em-dashes, `...` not the ellipsis glyph, plain quotes.
  Runtime non-ASCII output is fine via escapes (e.g. `"\u{23f0}"`).
- Fire-time / reminder-offset semantics live in datecore
  (`reminderOffset`) so the plugin and daemon agree; don't fork them.
