import { MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import { DatePicker, PickerValue } from "./datePicker";
import {
	nowEditorExtensions,
	PickerHost,
	dateTokenAt,
	appendLinkIcon,
	appendReminderIcon,
	refreshPillsEffect,
	reminderPillState,
} from "./editorExtension";
import {
	DateFormat,
	DATE_FORMAT_LABELS,
	DATE_FORMAT_ORDER,
	DATE_TOKEN_REGEX,
	ParsedDate,
	TimeFormat,
	dateTokenRegexGlobal,
	formatPill,
	formatToken,
	isoDate,
	parseNaturalDate,
	parseToken,
} from "./dateUtils";

// Whether an element sits inside a reading-view task list item that Obsidian has
// rendered as completed (its checkbox is checked). Used to strike through a
// date pill on a done task, mirroring the daemon's isCompletedTaskLine check.
function inCompletedTask(el: Element | null): boolean {
	const li = el?.closest("li.task-list-item");
	if (!li) return false;
	const mark = li.getAttribute("data-task");
	return li.classList.contains("is-checked") || mark === "x" || mark === "X";
}

interface NowSettings {
	// Format applied to dates chosen from the calendar (no explicit typed
	// format). Typed relative expressions still become "rel"; typed absolute
	// dates keep their absolute style.
	defaultFormat: DateFormat;
	// Time format applied to new timed dates.
	defaultTimeFormat: TimeFormat;
	// Whether new dates are stored as [[YYYY-MM-DD]] wikilinks (graph mentions)
	// by default. Still toggleable per date from the picker.
	defaultLinked: boolean;
}

const DEFAULT_SETTINGS: NowSettings = {
	defaultFormat: "rel",
	defaultTimeFormat: "12",
	defaultLinked: true,
};

export default class NowPlugin extends Plugin implements PickerHost {
	settings: NowSettings = { ...DEFAULT_SETTINGS };
	private activePicker: DatePicker | null = null;
	private session: { view: EditorView; anchor: number } | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerEditorExtension(nowEditorExtensions(this));
		this.registerMarkdownPostProcessor((el, ctx) =>
			this.decorateReadingView(el, ctx.sourcePath)
		);
		this.addSettingTab(new NowSettingTab(this));

		// A linked date's pill is styled by whether its daily note exists, which
		// changes outside the document (note created/deleted/renamed elsewhere).
		// Rebuild the editor pills whenever the vault's file set changes.
		const refresh = () => this.refreshPills();
		this.registerEvent(this.app.vault.on("create", refresh));
		this.registerEvent(this.app.vault.on("delete", refresh));
		this.registerEvent(this.app.vault.on("rename", refresh));
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
			initialTimeFormat: this.settings.defaultTimeFormat,
			initialTz: null,
			initialReminder: "none",
			initialLinked: this.settings.defaultLinked,
			mode: "new",
			onSubmit: (value) => this.commitSessionValue(value),
			onClear: () => this.clearSession(),
			onCancel: () => {
				this.session = null;
				this.activePicker = null;
				view.focus();
			},
			onOpenNote: (date) => {
				this.session = null;
				this.activePicker = null;
				this.openDatePage(isoDate(date), false);
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

	getDefaultTimeFormat(): TimeFormat {
		return this.settings.defaultTimeFormat;
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
		const token = formatToken(
			value.date,
			value.hasTime,
			{ format: value.format, timeFormat: value.timeFormat, tz: value.tz },
			value.reminder,
			value.linked
		);
		view.dispatch({
			changes: { from: anchor, to, insert: token },
			selection: { anchor: anchor + token.length },
		});
		view.focus();
	}

	// Clear during typing: remove the "@" and anything typed after it.
	private clearSession(): void {
		if (!this.session) return;
		const { view, anchor } = this.session;
		this.session = null;
		this.activePicker = null;
		const head = view.state.selection.main.head;
		const to = Math.max(anchor + 1, head);
		view.dispatch({
			changes: { from: anchor, to, insert: "" },
			selection: { anchor },
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
			initialTimeFormat:
				parsed && parsed.timeFormat
					? parsed.timeFormat
					: this.settings.defaultTimeFormat,
			initialTz: parsed ? parsed.tz : null,
			initialReminder: parsed ? parsed.reminder : "none",
			initialLinked: parsed ? parsed.linked : this.settings.defaultLinked,
			mode: "edit",
			onSubmit: (value) => {
				this.activePicker = null;
				const current = dateTokenAt(view, from) ?? { from, to };
				const token = formatToken(
					value.date,
					value.hasTime,
					{ format: value.format, timeFormat: value.timeFormat, tz: value.tz },
					value.reminder,
					value.linked
				);
				view.dispatch({
					changes: { from: current.from, to: current.to, insert: token },
					selection: { anchor: current.from + token.length },
				});
				view.focus();
			},
			onClear: () => {
				this.activePicker = null;
				const current = dateTokenAt(view, from) ?? { from, to };
				view.dispatch({
					changes: { from: current.from, to: current.to, insert: "" },
					selection: { anchor: current.from },
				});
				view.focus();
			},
			onCancel: () => {
				this.activePicker = null;
				view.focus();
			},
			onOpenNote: (date) => {
				this.activePicker = null;
				this.openDatePage(isoDate(date), false);
			},
		});
	}

	// Opens (or creates) the daily note for an ISO date, resolved relative to the
	// active file so Obsidian's daily-note folder settings apply.
	openDatePage(iso: string, newLeaf: boolean): void {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		void this.app.workspace.openLinkText(iso, sourcePath, newLeaf);
	}

	// Whether the note a linked date points at already exists (resolved the same
	// way Obsidian resolves the [[YYYY-MM-DD]] link), so an unresolved pill can be
	// styled to signal that clicking it would create the note.
	dateNoteExists(iso: string): boolean {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		return this.app.metadataCache.getFirstLinkpathDest(iso, sourcePath) !== null;
	}

	// Force every open editor's pills to rebuild so their resolved/unresolved
	// styling reflects the current vault (see refreshPillsEffect).
	private refreshPills(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			// editor.cm is the underlying CodeMirror 6 EditorView (undocumented).
			const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
			cm?.dispatch({ effects: refreshPillsEffect.of(null) });
		});
	}

	// --- reading (preview) mode ---------------------------------------------

	private decorateReadingView(el: HTMLElement, sourcePath: string): void {
		// A linked date is rendered by Obsidian as an <a> internal link before we
		// see the DOM, splitting the token across sibling nodes; absorb those first
		// so the plain text pass below only has to handle unlinked tokens.
		this.decorateLinkedReadingView(el, sourcePath);

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
				const parsed = parseToken(m[0]);
				const completed = inCompletedTask(textNode.parentElement);
				frag.appendChild(
					parsed
						? this.buildReadingPill(parsed, sourcePath, completed)
						: document.createTextNode(m[0])
				);
				last = m.index + m[0].length;
			}
			if (last < text.length) {
				frag.appendChild(document.createTextNode(text.slice(last)));
			}
			textNode.parentNode?.replaceChild(frag, textNode);
		}
	}

	// Finds the ISO-date internal links Obsidian rendered from a linked token
	// (@[[2026-07-05]]...) and folds the surrounding "@" and "~segments" text back
	// into a single pill, so linked and unlinked dates look identical.
	private decorateLinkedReadingView(el: HTMLElement, sourcePath: string): void {
		const anchors = Array.from(
			el.querySelectorAll("a.internal-link")
		) as HTMLAnchorElement[];
		for (const a of anchors) {
			const iso = (a.getAttribute("data-href") ?? a.textContent ?? "").trim();
			if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;

			const prev = a.previousSibling;
			if (!prev || prev.nodeType !== Node.TEXT_NODE) continue;
			const prevText = prev.nodeValue ?? "";
			if (!prevText.endsWith("@")) continue;
			// Same word-boundary guard as inline typing: "@" must not follow a
			// non-space character (avoids e.g. an email address).
			const before = prevText.slice(0, -1);
			if (before && /\S$/.test(before)) continue;

			const next = a.nextSibling;
			const nextText =
				next && next.nodeType === Node.TEXT_NODE ? next.nodeValue ?? "" : "";

			// Rebuild the canonical token and see how much of the trailing text
			// (an optional time and the "~" segments) belongs to it. Use the
			// non-global regex so `.match` returns an index (a global-flag match
			// returns only substrings, dropping `.index` and the capture groups).
			const prefix = `@[[${iso}]]`;
			const m = `${prefix}${nextText}`.match(DATE_TOKEN_REGEX);
			if (!m || m.index !== 0) continue;
			const parsed = parseToken(m[0]);
			if (!parsed) continue;

			const completed = inCompletedTask(a);
			prev.nodeValue = before;
			a.replaceWith(this.buildReadingPill(parsed, sourcePath, completed));
			if (next && next.nodeType === Node.TEXT_NODE) {
				next.nodeValue = nextText.slice(m[0].length - prefix.length);
			}
		}
	}

	// Builds the reading-view pill for a parsed token. Linked dates get a glyph
	// and open their note on click (a new pane with a modifier), matching the
	// editor pill.
	private buildReadingPill(
		parsed: ParsedDate,
		sourcePath: string,
		completed: boolean
	): HTMLElement {
		const span = document.createElement("span");
		span.className = "now-date-pill";
		if (completed) span.classList.add("now-date-pill-done");
		span.appendChild(
			document.createTextNode(
				formatPill(parsed.date, parsed.hasTime, {
					format: parsed.format,
					timeFormat: parsed.timeFormat ?? this.settings.defaultTimeFormat,
					tz: parsed.tz,
				})
			)
		);
		const rstate = reminderPillState(parsed);
		if (rstate !== "none") {
			span.classList.add(`now-date-pill-reminder-${rstate}`);
			appendReminderIcon(span);
		}
		// Link chip goes last, after any reminder icon.
		if (parsed.linked) {
			const iso = isoDate(parsed.date);
			const exists =
				this.app.metadataCache.getFirstLinkpathDest(iso, sourcePath) !== null;
			span.classList.add("now-date-pill-linked");
			span.setAttribute(
				"aria-label",
				exists ? "Open the date note" : "Create the date note"
			);
			// No chip for a not-yet-created note; clicking the pill still creates it.
			if (exists) appendLinkIcon(span);
			span.addEventListener("click", (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(
					iso,
					sourcePath,
					e.metaKey || e.ctrlKey
				);
			});
		}
		return span;
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

		new Setting(containerEl)
			.setName("Default time format")
			.setDesc("Clock format applied to new dates that include a time.")
			.addDropdown((dd) => {
				dd.addOption("12", "12 hour");
				dd.addOption("24", "24 hour");
				dd.setValue(this.plugin.settings.defaultTimeFormat);
				dd.onChange(async (value) => {
					this.plugin.settings.defaultTimeFormat = value as TimeFormat;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Link dates by default")
			.setDesc(
				"Store new dates as [[YYYY-MM-DD]] wikilinks so they appear in the " +
					"graph and can be opened as daily notes. You can still toggle this " +
					"per date in the picker."
			)
			.addToggle((tg) => {
				tg.setValue(this.plugin.settings.defaultLinked);
				tg.onChange(async (value) => {
					this.plugin.settings.defaultLinked = value;
					await this.plugin.saveSettings();
				});
			});
	}
}
