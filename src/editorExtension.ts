import { Extension } from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	MatchDecorator,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { DATE_TOKEN_REGEX, dateTokenRegexGlobal } from "./dateUtils";

// The plugin implements these; kept as an interface to avoid a circular import.
export interface PickerHost {
	openPickerForNew(view: EditorView, anchor: number): void;
	openPickerForEdit(view: EditorView, from: number, to: number): void;
}

// Given a document position, returns the bounds of the @date token under it,
// or null if the position is not inside one.
export function dateTokenAt(
	view: EditorView,
	pos: number
): { from: number; to: number } | null {
	const line = view.state.doc.lineAt(pos);
	const text = line.text;
	const re = dateTokenRegexGlobal();
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const from = line.from + m.index;
		const to = from + m[0].length;
		if (pos >= from && pos <= to) return { from, to };
	}
	return null;
}

// Extension 1: watch for a freshly typed "@" and open the picker.
function triggerExtension(host: PickerHost): Extension {
	return EditorView.updateListener.of((update: ViewUpdate) => {
		if (!update.docChanged) return;
		// Ignore programmatic inserts (e.g. our own token insertion).
		let anchor = -1;
		update.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
			if (inserted.toString() === "@") anchor = toB - 1;
		});
		if (anchor < 0) return;
		// Defer so we don't reenter the CM update cycle.
		const view = update.view;
		window.setTimeout(() => host.openPickerForNew(view, anchor), 0);
	});
}

// Extension 2: highlight @date tokens as pills and open the picker on click.
function pillExtension(host: PickerHost): Extension {
	const matcher = new MatchDecorator({
		regexp: dateTokenRegexGlobal(),
		decoration: () =>
			Decoration.mark({
				class: "now-date-pill",
				attributes: { "data-now-date": "true" },
			}),
	});

	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = matcher.createDeco(view);
			}
			update(update: ViewUpdate) {
				this.decorations = matcher.updateDeco(update, this.decorations);
			}
		},
		{
			decorations: (v) => v.decorations,
			eventHandlers: {
				mousedown(event: MouseEvent, view: EditorView) {
					const target = event.target as HTMLElement | null;
					if (!target || event.button !== 0) return;
					if (
						!target.classList.contains("now-date-pill") &&
						!target.closest(".now-date-pill")
					)
						return;
					const pos = view.posAtCoords({
						x: event.clientX,
						y: event.clientY,
					});
					if (pos == null) return;
					const token = dateTokenAt(view, pos);
					if (!token) return;
					event.preventDefault();
					event.stopPropagation();
					host.openPickerForEdit(view, token.from, token.to);
				},
			},
		}
	);
}

export function nowEditorExtensions(host: PickerHost): Extension[] {
	return [triggerExtension(host), pillExtension(host)];
}

export { DATE_TOKEN_REGEX };
