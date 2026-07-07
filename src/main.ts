import { Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";
import { DatePicker } from "./datePicker";
import {
	nowEditorExtensions,
	PickerHost,
	dateTokenAt,
} from "./editorExtension";
import { dateTokenRegexGlobal, parseToken } from "./dateUtils";

export default class NowPlugin extends Plugin implements PickerHost {
	private activePicker: DatePicker | null = null;

	async onload(): Promise<void> {
		this.registerEditorExtension(nowEditorExtensions(this));
		this.registerMarkdownPostProcessor((el) => this.decorateReadingView(el));
	}

	onunload(): void {
		this.closeActivePicker();
	}

	private closeActivePicker(): void {
		if (this.activePicker) {
			this.activePicker.close(false);
			this.activePicker = null;
		}
	}

	// --- PickerHost implementation -------------------------------------------

	openPickerForNew(view: EditorView, anchor: number): void {
		// Bail if the "@" is gone (deleted/undone before the picker opened).
		if (
			anchor >= view.state.doc.length ||
			view.state.sliceDoc(anchor, anchor + 1) !== "@"
		) {
			return;
		}
		this.closeActivePicker();
		const coords = view.coordsAtPos(anchor);
		if (!coords) return;

		this.activePicker = new DatePicker({
			coords: {
				left: coords.left,
				top: coords.top,
				bottom: coords.bottom,
			},
			initialDate: new Date(),
			initialHasTime: false,
			onSubmit: (token) => {
				this.activePicker = null;
				const head = view.state.selection.main.head;
				const to = Math.max(anchor + 1, head);
				view.dispatch({
					changes: { from: anchor, to, insert: token },
					selection: { anchor: anchor + token.length },
				});
				view.focus();
			},
			onCancel: () => {
				this.activePicker = null;
				view.focus();
			},
		});
	}

	openPickerForEdit(view: EditorView, from: number, to: number): void {
		this.closeActivePicker();
		const tokenText = view.state.sliceDoc(from, to);
		const parsed = parseToken(tokenText);
		const coords = view.coordsAtPos(from);
		if (!coords) return;

		this.activePicker = new DatePicker({
			coords: {
				left: coords.left,
				top: coords.top,
				bottom: coords.bottom,
			},
			initialDate: parsed ? parsed.date : new Date(),
			initialHasTime: parsed ? parsed.hasTime : false,
			onSubmit: (token) => {
				this.activePicker = null;
				// Re-resolve the token bounds in case the doc shifted.
				const current = dateTokenAt(view, from) ?? { from, to };
				view.dispatch({
					changes: {
						from: current.from,
						to: current.to,
						insert: token,
					},
					selection: { anchor: current.from + token.length },
				});
				view.focus();
			},
			onCancel: () => {
				this.activePicker = null;
				view.focus();
			},
		});
	}

	// --- Reading (preview) mode ----------------------------------------------

	private decorateReadingView(el: HTMLElement): void {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const parent = node.parentElement;
			if (!parent) continue;
			// Skip code/pre and anything already decorated.
			if (parent.closest("code, pre, .now-date-pill")) continue;
			if (dateTokenRegexGlobal().test(node.nodeValue ?? "")) {
				textNodes.push(node as Text);
			}
		}

		for (const textNode of textNodes) {
			const text = textNode.nodeValue ?? "";
			const re = dateTokenRegexGlobal();
			const frag = document.createDocumentFragment();
			let last = 0;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) {
					frag.appendChild(
						document.createTextNode(text.slice(last, m.index))
					);
				}
				const span = document.createElement("span");
				span.className = "now-date-pill";
				span.textContent = m[0];
				frag.appendChild(span);
				last = m.index + m[0].length;
			}
			if (last < text.length) {
				frag.appendChild(document.createTextNode(text.slice(last)));
			}
			textNode.parentNode?.replaceChild(frag, textNode);
		}
	}
}
