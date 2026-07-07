import { Plugin, PluginSettingTab, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import { DatePicker, PickerValue } from "./datePicker";
import { nowEditorExtensions, PickerHost, dateTokenAt } from "./editorExtension";
import {
	DateFormat,
	DATE_FORMAT_LABELS,
	DATE_FORMAT_ORDER,
	dateTokenRegexGlobal,
	formatDisplay,
	formatToken,
	parseNaturalDate,
	parseToken,
} from "./dateUtils";

interface NowSettings {
	// Format applied to dates chosen from the calendar (no explicit typed
	// format). Typed relative expressions still become "rel"; typed absolute
	// dates keep their absolute style.
	defaultFormat: DateFormat;
}

const DEFAULT_SETTINGS: NowSettings = {
	defaultFormat: "rel",
};

export default class NowPlugin extends Plugin implements PickerHost {
	settings: NowSettings = { ...DEFAULT_SETTINGS };
	private activePicker: DatePicker | null = null;
	private session: { view: EditorView; anchor: number } | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerEditorExtension(nowEditorExtensions(this));
		this.registerMarkdownPostProcessor((el) => this.decorateReadingView(el));
		this.addSettingTab(new NowSettingTab(this));
	}

	onunload(): void {
		this.endSession();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// --- inline typing session ----------------------------------------------

	beginSession(view: EditorView, anchor: number): void {
		this.endSession();
		// Only trigger at a word boundary, so "@" inside e.g. an email address
		// does not pop the picker.
		const before =
			anchor > 0 ? view.state.doc.sliceString(anchor - 1, anchor) : "";
		if (before && /\S/.test(before)) return;

		const coords = view.coordsAtPos(anchor);
		if (!coords) return;
		this.session = { view, anchor };
		this.activePicker = new DatePicker({
			coords: { left: coords.left, top: coords.top, bottom: coords.bottom },
			initialDate: new Date(),
			initialHasTime: false,
			initialFormat: this.settings.defaultFormat,
			mode: "new",
			onSubmit: (value) => this.commitSessionValue(value),
			onCancel: () => {
				this.session = null;
				this.activePicker = null;
				view.focus();
			},
		});
		// Reflect anything already typed after the "@".
		this.updateSession(view);
	}

	updateSession(view: EditorView): void {
		if (!this.session || !this.activePicker) return;
		const { anchor } = this.session;
		const doc = view.state.doc;
		if (anchor >= doc.length || doc.sliceString(anchor, anchor + 1) !== "@") {
			this.endSession();
			return;
		}
		const head = view.state.selection.main.head;
		const line = doc.lineAt(anchor);
		if (head <= anchor || head > line.to) {
			this.endSession();
			return;
		}
		const query = doc.sliceString(anchor + 1, head);
		const nl = parseNaturalDate(query);
		if (nl) {
			this.activePicker.setSelectedDate(nl.date);
			this.activePicker.setHasTime(nl.hasTime);
			this.activePicker.setFormat(nl.relative ? "rel" : nl.format);
			this.activePicker.setPreview();
		} else if (query.trim() === "") {
			this.activePicker.setFormat(this.settings.defaultFormat);
			this.activePicker.setPreview();
		} else {
			this.activePicker.setPreview("No match");
		}
	}

	isSessionActive(): boolean {
		return !!(this.session && this.activePicker);
	}

	commitSession(): boolean {
		if (!this.session || !this.activePicker) return false;
		this.activePicker.submit();
		return true;
	}

	cancelSession(): boolean {
		if (!this.session) return false;
		const view = this.session.view;
		this.endSession();
		view.focus();
		return true;
	}

	navigateSession(deltaDays: number): boolean {
		if (!this.session || !this.activePicker) return false;
		this.activePicker.navigate(deltaDays);
		return true;
	}

	private commitSessionValue(value: PickerValue): void {
		if (!this.session) return;
		const { view, anchor } = this.session;
		this.session = null;
		this.activePicker = null;
		const head = view.state.selection.main.head;
		const to = Math.max(anchor + 1, head);
		const token = formatToken(value.date, value.hasTime, value.format);
		view.dispatch({
			changes: { from: anchor, to, insert: token },
			selection: { anchor: anchor + token.length },
		});
		view.focus();
	}

	private endSession(): void {
		this.session = null;
		if (this.activePicker) {
			this.activePicker.close(false);
			this.activePicker = null;
		}
	}

	// --- editing an existing pill -------------------------------------------

	openPickerForEdit(view: EditorView, from: number, to: number): void {
		this.endSession();
		const parsed = parseToken(view.state.sliceDoc(from, to));
		const coords = view.coordsAtPos(from);
		if (!coords) return;
		this.activePicker = new DatePicker({
			coords: { left: coords.left, top: coords.top, bottom: coords.bottom },
			initialDate: parsed ? parsed.date : new Date(),
			initialHasTime: parsed ? parsed.hasTime : false,
			initialFormat: parsed ? parsed.format : this.settings.defaultFormat,
			mode: "edit",
			onSubmit: (value) => {
				this.activePicker = null;
				const current = dateTokenAt(view, from) ?? { from, to };
				const token = formatToken(value.date, value.hasTime, value.format);
				view.dispatch({
					changes: { from: current.from, to: current.to, insert: token },
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

	// --- reading (preview) mode ---------------------------------------------

	private decorateReadingView(el: HTMLElement): void {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const targets: Text[] = [];
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const parent = node.parentElement;
			if (!parent) continue;
			if (parent.closest("code, pre, .now-date-pill")) continue;
			if (dateTokenRegexGlobal().test(node.nodeValue ?? "")) {
				targets.push(node as Text);
			}
		}

		for (const textNode of targets) {
			const text = textNode.nodeValue ?? "";
			const re = dateTokenRegexGlobal();
			const frag = document.createDocumentFragment();
			let last = 0;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				if (m.index > last) {
					frag.appendChild(document.createTextNode(text.slice(last, m.index)));
				}
				const span = document.createElement("span");
				span.className = "now-date-pill";
				const parsed = parseToken(m[0]);
				span.textContent = parsed
					? formatDisplay(parsed.date, parsed.hasTime, parsed.format)
					: m[0];
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

class NowSettingTab extends PluginSettingTab {
	constructor(private plugin: NowPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default date format")
			.setDesc(
				"Applied to dates picked from the calendar. Typing a relative " +
					"phrase (today, in 3 days) always uses Relative; typing an " +
					"absolute date keeps its own format."
			)
			.addDropdown((dd) => {
				for (const fmt of DATE_FORMAT_ORDER) {
					dd.addOption(fmt, DATE_FORMAT_LABELS[fmt]);
				}
				dd.setValue(this.plugin.settings.defaultFormat);
				dd.onChange(async (value) => {
					this.plugin.settings.defaultFormat = value as DateFormat;
					await this.plugin.saveSettings();
				});
			});
	}
}
