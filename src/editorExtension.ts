import { Extension, Prec, RangeSetBuilder } from "@codemirror/state";
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
	parseToken,
	reminderFireLocal,
} from "./dateUtils";

export type ReminderPillState = "none" | "past" | "future";

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
		readonly host: PickerHost
	) {
		super();
	}

	eq(other: DatePillWidget): boolean {
		return other.display === this.display && other.reminder === this.reminder;
	}

	toDOM(view: EditorView): HTMLElement {
		const span = document.createElement("span");
		span.className = "now-date-pill";
		span.appendChild(document.createTextNode(this.display));
		if (this.reminder !== "none") {
			span.classList.add(`now-date-pill-reminder-${this.reminder}`);
			appendReminderIcon(span);
		}
		span.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
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
				builder.add(
					start,
					end,
					Decoration.replace({
						widget: new DatePillWidget(display, reminderPillState(parsed), host),
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
				if (update.docChanged || update.viewportChanged) {
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
	return [triggerExtension(host), sessionKeymap(host), pillExtension(host)];
}
