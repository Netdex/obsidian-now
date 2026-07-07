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
- Click a day -> `@YYYY-MM-DD` is inserted (the typed `@` is replaced).
- Toggle **Include time** and set a time -> `@YYYY-MM-DD HH:mm`.
- **Enter** commits, **Escape** dismisses, clicking outside dismisses.
- Click an existing highlighted date to re-open the picker and change it.

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
