# Now - Date Picker for Obsidian

Type `@` anywhere in the editor to open a date picker, Notion-style. Pick a day
and an inline date token is inserted:

```
@2026-07-05
```

Optionally enable **Include time** in the picker to get:

```
@2026-07-05 14:30
```

Inserted dates are highlighted as pills. **Click a pill** to reopen the picker
and edit the date. Pills are highlighted in reading view as well.

## Usage

- Type `@` -> the calendar pops up at the caret.
- **Type a date in natural language** and press **Enter**: `@today`, `@tomorrow`,
  `@in 3 days`, `@next friday`, `@jul 5`, `@2026-07-05`. Relative phrases display
  relatively ("Today"); absolute dates display absolutely.
- Or click a day in the calendar.
- Toggle **Include time** to add a time.
- **Enter** commits, **Escape** dismisses, arrow keys move the selection.
- Click an existing pill to re-open the picker and change the date, time, or format.

## Per-date format

Each date carries its own display format, chosen in the picker's **Date format**
menu (Relative, Full date, Short date, Month/Day/Year, Day/Month/Year,
Year/Month/Day, ISO). The **default** for calendar picks is set in
Settings -> Now - Date Picker (defaults to Relative).

The underlying date is always stored canonically in the note, so a relative
label like "Today" is recomputed on display and never goes stale. The stored
text looks like `@2026-07-05` (absolute) or `@2026-07-05~rel` (relative); the
`~code` suffix is hidden by the pill and only visible if the note is opened
without this plugin.

## Development

```bash
npm install
npm run dev     # watch build -> main.js
npm run build   # type-check + production build
```

## Installing into a vault

Copy `manifest.json`, `main.js` and `styles.css` into:

```
<your-vault>/.obsidian/plugins/obsidian-now/
```

Then enable **Now - Date Picker** under Settings -> Community plugins.
