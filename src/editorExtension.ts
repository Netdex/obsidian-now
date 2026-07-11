import { Extension, Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { setIcon } from "obsidian";
import {
	ParsedDate,
	TimeFormat,
	dateTokenRegexGlobal,
	formatPill,
	isoDate,
	parseToken,
	reminderFireLocal,
} from "./dateUtils";

export type ReminderPillState = "none" | "past" | "future";

// Dispatched into an editor to force the date pills to rebuild. Used when a
// linked date's target note is created/deleted/renamed, flipping it between
// resolved and unresolved (which isn't a document change, so the pill view
// plugin wouldn't otherwise notice).
export const refreshPillsEffect = StateEffect.define<null>();

// Whether a token's reminder has already fired ("past") or is still upcoming
// ("future"), for colouring the pill. Uses local time (see reminderFireLocal).
export function reminderPillState(parsed: ParsedDate): ReminderPillState {
	if (parsed.reminder === "none") return "none";
	const fire = reminderFireLocal(parsed);
	if (!fire) return "future";
	return fire.getTime() <= Date.now() ? "past" : "future";
}

// Adds an alarm-clock suffix icon to a pill that carries a reminder, Notion-style.
export function appendReminderIcon(el: HTMLElement): void {
	const icon = el.createSpan({ cls: "now-date-reminder-icon" });
	setIcon(icon, "alarm-clock");
}

// Adds a small link glyph to a pill whose date is a graph wikilink. Clicking the
// glyph (returned so callers can detect it) opens the date's note.
export function appendLinkIcon(el: HTMLElement): HTMLElement {
	const icon = el.createSpan({ cls: "now-date-link-icon" });
	setIcon(icon, "link");
	return icon;
}

// The plugin implements these; kept as an interface to avoid a circular import.
export interface PickerHost {
	// Inline typing session.
	beginSession(view: EditorView, anchor: number): void;
	updateSession(view: EditorView): void;
	isSessionActive(): boolean;
	commitSession(): boolean;
	cancelSession(): boolean;
	navigateSession(deltaDays: number): boolean;
	// Editing an existing pill.
	openPickerForEdit(view: EditorView, from: number, to: number): void;
	// Follow a graph-linked date to its daily note (Ctrl/Cmd-click, glyph, etc.).
	openDatePage(iso: string, newLeaf: boolean): void;
	// Whether the daily note a linked date points at already exists in the vault
	// (drives the "unresolved" pill styling for not-yet-created notes).
	dateNoteExists(iso: string): boolean;
	// Fallback time format for tokens that predate the ~t12/~t24 suffix.
	getDefaultTimeFormat(): TimeFormat;
}

// Given a document position, returns the bounds of the @date token under it.
export function dateTokenAt(
	view: EditorView,
	pos: number
): { from: number; to: number } | null {
	const line = view.state.doc.lineAt(pos);
	const re = dateTokenRegexGlobal();
	let m: RegExpExecArray | null;
	while ((m = re.exec(line.text)) !== null) {
		const from = line.from + m.index;
		const to = from + m[0].length;
		if (pos >= from && pos <= to) return { from, to };
	}
	return null;
}

// The pill shown in place of the raw token text.
class DatePillWidget extends WidgetType {
	constructor(
		readonly display: string,
		readonly reminder: ReminderPillState,
		readonly linked: boolean,
		readonly iso: string,
		readonly noteExists: boolean,
		readonly host: PickerHost
	) {
		super();
	}

	eq(other: DatePillWidget): boolean {
		return (
			other.display === this.display &&
			other.reminder === this.reminder &&
			other.linked === this.linked &&
			other.iso === this.iso &&
			other.noteExists === this.noteExists
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const span = document.createElement("span");
		span.className = "now-date-pill";
		span.appendChild(document.createTextNode(this.display));
		if (this.reminder !== "none") {
			span.classList.add(`now-date-pill-reminder-${this.reminder}`);
			appendReminderIcon(span);
		}
		// Link chip goes last, after any reminder icon.
		let linkIcon: HTMLElement | null = null;
		if (this.linked) {
			span.classList.add("now-date-pill-linked");
			if (!this.noteExists) span.classList.add("now-date-pill-unresolved");
			span.setAttribute(
				"aria-label",
				this.noteExists
					? "Ctrl/Cmd-click to open the date note"
					: "Ctrl/Cmd-click to create the date note"
			);
			linkIcon = appendLinkIcon(span);
		}
		span.addEventListener("mousedown", (e) => {
			// Left (0) edits or navigates; middle (1) navigates to a new pane.
			if (e.button !== 0 && e.button !== 1) return;
			e.preventDefault();
			e.stopPropagation();
			const onGlyph = linkIcon !== null && linkIcon.contains(e.target as Node);
			const modifier = e.metaKey || e.ctrlKey;
			if (this.linked && (e.button === 1 || modifier || onGlyph)) {
				// New pane on middle-click or with a modifier, mirroring Obsidian.
				this.host.openDatePage(this.iso, e.button === 1 || modifier);
				return;
			}
			if (e.button !== 0) return; // middle-click on a non-linked pill: nothing
			const pos = view.posAtDOM(span);
			const token = dateTokenAt(view, pos) ?? dateTokenAt(view, pos + 1);
			if (token) this.host.openPickerForEdit(view, token.from, token.to);
		});
		return span;
	}

	ignoreEvent(): boolean {
		// Let our own mousedown handler run; keep CM from processing the event.
		return true;
	}
}

// Extension 1: watch for a freshly typed "@" (start session) and keep the
// active session in sync as the user types after it.
function triggerExtension(host: PickerHost): Extension {
	return EditorView.updateListener.of((update: ViewUpdate) => {
		if (update.docChanged) {
			let anchor = -1;
			update.changes.iterChanges((_fa, _ta, _fb, toB, inserted) => {
				if (inserted.toString() === "@") anchor = toB - 1;
			});
			if (anchor >= 0) {
				host.beginSession(update.view, anchor);
				return;
			}
		}
		if (
			host.isSessionActive() &&
			(update.docChanged || update.selectionSet)
		) {
			host.updateSession(update.view);
		}
	});
}

// Extension 2: while a session is active, Enter commits, Escape cancels, and
// arrows navigate the calendar. High precedence so it beats the default Enter.
function sessionKeymap(host: PickerHost): Extension {
	return Prec.highest(
		keymap.of([
			{ key: "Enter", run: () => (host.isSessionActive() ? host.commitSession() : false) },
			{ key: "Escape", run: () => (host.isSessionActive() ? host.cancelSession() : false) },
			{ key: "ArrowUp", run: () => (host.isSessionActive() ? host.navigateSession(-7) : false) },
			{ key: "ArrowDown", run: () => (host.isSessionActive() ? host.navigateSession(7) : false) },
			{ key: "ArrowLeft", run: () => (host.isSessionActive() ? host.navigateSession(-1) : false) },
			{ key: "ArrowRight", run: () => (host.isSessionActive() ? host.navigateSession(1) : false) },
		])
	);
}

// Extension 3: render every @date token as an atomic pill in its stored format.
function pillExtension(host: PickerHost): Extension {
	function build(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();
		for (const { from, to } of view.visibleRanges) {
			const text = view.state.doc.sliceString(from, to);
			const re = dateTokenRegexGlobal();
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				const start = from + m.index;
				const end = start + m[0].length;
				const parsed = parseToken(m[0]);
				if (!parsed) continue;
				const display = formatPill(parsed.date, parsed.hasTime, {
					format: parsed.format,
					timeFormat: parsed.timeFormat ?? host.getDefaultTimeFormat(),
					tz: parsed.tz,
				});
				const iso = isoDate(parsed.date);
				builder.add(
					start,
					end,
					Decoration.replace({
						widget: new DatePillWidget(
							display,
							reminderPillState(parsed),
							parsed.linked,
							iso,
							parsed.linked ? host.dateNoteExists(iso) : true,
							host
						),
					})
				);
			}
		}
		return builder.finish();
	}

	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view);
			}
			update(update: ViewUpdate) {
				if (
						update.docChanged ||
						update.viewportChanged ||
						update.transactions.some((tr) =>
							tr.effects.some((e) => e.is(refreshPillsEffect))
						)
					) {
					this.decorations = build(update.view);
				}
			}
		},
		{
			decorations: (v) => v.decorations,
			// Atomic: cursor skips the pill and backspace removes it whole.
			provide: (p) =>
				EditorView.atomicRanges.of((view) => {
					return view.plugin(p)?.decorations ?? Decoration.none;
				}),
		}
	);
	return plugin;
}

export function nowEditorExtensions(host: PickerHost): Extension[] {
	// The pill runs at high precedence so its atomic replace decoration wins over
	// Obsidian's own live-preview rendering of the inner [[wikilink]].
	return [triggerExtension(host), sessionKeymap(host), Prec.high(pillExtension(host))];
}
