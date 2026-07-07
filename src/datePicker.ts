import {
	DateFormat,
	DATE_FORMAT_LABELS,
	DATE_FORMAT_ORDER,
	MONTH_NAMES_FULL,
	WEEKDAY_HEADERS,
	formatDisplay,
	isSameDay,
} from "./dateUtils";

export interface PickerValue {
	date: Date;
	hasTime: boolean;
	format: DateFormat;
}

export interface DatePickerOptions {
	coords: { left: number; top: number; bottom: number };
	initialDate: Date;
	initialHasTime: boolean;
	initialFormat: DateFormat;
	// "new" is used while typing inline (editor keeps focus, plugin drives keys);
	// "edit" is used when a pill is clicked (picker handles its own keys).
	mode: "new" | "edit";
	onSubmit: (value: PickerValue) => void;
	onCancel: () => void;
}

// A self-contained floating calendar popup. The plugin owns its lifecycle and,
// during inline typing, drives it via the public setters below.
export class DatePicker {
	private root: HTMLElement;
	private gridEl!: HTMLElement;
	private headerLabel!: HTMLElement;
	private previewEl!: HTMLElement;
	private timeInput!: HTMLInputElement;
	private timeToggle!: HTMLInputElement;
	private formatValueEl!: HTMLElement;
	private formatList!: HTMLElement;

	private viewDate: Date;
	private selected: Date;
	private hasTime: boolean;
	private format: DateFormat;
	private readonly mode: "new" | "edit";
	private submitted = false;
	private formatListOpen = false;

	private onSubmit: DatePickerOptions["onSubmit"];
	private onCancel: DatePickerOptions["onCancel"];
	private anchor: DatePickerOptions["coords"];

	private readonly onDocMouseDown = (e: MouseEvent) => {
		if (!this.root.contains(e.target as Node)) this.close(true);
	};
	private readonly onKeyDown = (e: KeyboardEvent) => {
		// Only "edit" mode captures keys; while typing inline the plugin's
		// editor keymap owns Enter/Escape/arrows instead.
		if (this.mode !== "edit") return;
		switch (e.key) {
			case "Escape":
				e.preventDefault();
				e.stopPropagation();
				this.close(true);
				break;
			case "Enter":
				e.preventDefault();
				e.stopPropagation();
				this.submit();
				break;
			case "ArrowLeft":
				e.preventDefault();
				this.navigate(-1);
				break;
			case "ArrowRight":
				e.preventDefault();
				this.navigate(1);
				break;
			case "ArrowUp":
				e.preventDefault();
				this.navigate(-7);
				break;
			case "ArrowDown":
				e.preventDefault();
				this.navigate(7);
				break;
		}
	};
	private readonly onReposition = () => this.reposition(this.anchor);

	constructor(opts: DatePickerOptions) {
		this.selected = new Date(opts.initialDate.getTime());
		this.viewDate = new Date(
			this.selected.getFullYear(),
			this.selected.getMonth(),
			1
		);
		this.hasTime = opts.initialHasTime;
		this.format = opts.initialFormat;
		this.mode = opts.mode;
		this.onSubmit = opts.onSubmit;
		this.onCancel = opts.onCancel;
		this.anchor = opts.coords;

		this.root = document.createElement("div");
		this.root.className = "now-datepicker";
		// Keep clicks inside from disturbing the editor selection.
		this.root.addEventListener("mousedown", (e) => e.preventDefault());
		document.body.appendChild(this.root);

		this.buildDom();
		this.renderMonth();
		this.updatePreview();
		this.reposition(this.anchor);

		document.addEventListener("mousedown", this.onDocMouseDown, true);
		document.addEventListener("keydown", this.onKeyDown, true);
		window.addEventListener("resize", this.onReposition);
		window.addEventListener("scroll", this.onReposition, true);
	}

	// --- public API driven by the plugin during inline typing ----------------

	get value(): PickerValue {
		if (this.hasTime) this.syncTimeFromInput();
		return {
			date: new Date(this.selected.getTime()),
			hasTime: this.hasTime,
			format: this.format,
		};
	}

	setSelectedDate(date: Date): void {
		this.selected.setFullYear(
			date.getFullYear(),
			date.getMonth(),
			date.getDate()
		);
		this.selected.setHours(date.getHours(), date.getMinutes(), 0, 0);
		this.viewDate = new Date(date.getFullYear(), date.getMonth(), 1);
		this.renderMonth();
		this.updatePreview();
	}

	setHasTime(hasTime: boolean): void {
		this.hasTime = hasTime;
		this.timeToggle.checked = hasTime;
		this.timeInput.disabled = !hasTime;
		if (hasTime) this.timeInput.value = this.timeString();
		this.updatePreview();
	}

	setFormat(format: DateFormat): void {
		this.format = format;
		this.formatValueEl.setText(DATE_FORMAT_LABELS[format]);
		this.updatePreview();
	}

	navigate(deltaDays: number): void {
		this.setSelectedDate(
			new Date(
				this.selected.getFullYear(),
				this.selected.getMonth(),
				this.selected.getDate() + deltaDays,
				this.selected.getHours(),
				this.selected.getMinutes()
			)
		);
	}

	// Optional hint (e.g. "No match"); falls back to the formatted selection.
	setPreview(message?: string): void {
		this.updatePreview(message);
	}

	submit(): void {
		this.submitted = true;
		const value = this.value;
		this.close(false);
		this.onSubmit(value);
	}

	// --- DOM ------------------------------------------------------------------

	private buildDom(): void {
		this.previewEl = this.root.createDiv({ cls: "now-dp-preview" });

		const header = this.root.createDiv({ cls: "now-dp-header" });
		const prev = header.createEl("button", { cls: "now-dp-nav", text: "<" });
		prev.setAttr("aria-label", "Previous month");
		prev.addEventListener("click", () => this.shiftMonth(-1));

		this.headerLabel = header.createDiv({ cls: "now-dp-title" });

		const nowBtn = header.createEl("button", {
			cls: "now-dp-now",
			text: "Now",
		});
		nowBtn.addEventListener("click", () => this.setSelectedDate(new Date()));

		const next = header.createEl("button", { cls: "now-dp-nav", text: ">" });
		next.setAttr("aria-label", "Next month");
		next.addEventListener("click", () => this.shiftMonth(1));

		const weekRow = this.root.createDiv({ cls: "now-dp-weekdays" });
		for (const w of WEEKDAY_HEADERS) {
			weekRow.createDiv({ cls: "now-dp-weekday", text: w });
		}

		this.gridEl = this.root.createDiv({ cls: "now-dp-grid" });

		// Date format row + collapsible menu.
		const fmtRow = this.root.createDiv({ cls: "now-dp-row now-dp-format-row" });
		fmtRow.createSpan({ cls: "now-dp-row-label", text: "Date format" });
		this.formatValueEl = fmtRow.createSpan({
			cls: "now-dp-row-value",
			text: DATE_FORMAT_LABELS[this.format],
		});
		fmtRow.createSpan({ cls: "now-dp-row-chevron", text: ">" });
		fmtRow.addEventListener("click", () => this.toggleFormatList());

		this.formatList = this.root.createDiv({ cls: "now-dp-format-list" });
		this.formatList.style.display = "none";
		for (const fmt of DATE_FORMAT_ORDER) {
			const item = this.formatList.createDiv({
				cls: "now-dp-format-item",
				text: DATE_FORMAT_LABELS[fmt],
			});
			item.addEventListener("click", () => {
				this.setFormat(fmt);
				this.toggleFormatList(false);
			});
		}

		// Time row.
		const timeRow = this.root.createDiv({ cls: "now-dp-row" });
		const label = timeRow.createEl("label", { cls: "now-dp-time-label" });
		this.timeToggle = label.createEl("input", { type: "checkbox" });
		this.timeToggle.checked = this.hasTime;
		label.createSpan({ text: "Include time" });

		this.timeInput = timeRow.createEl("input", {
			type: "time",
			cls: "now-dp-time-input",
		});
		this.timeInput.value = this.timeString();
		this.timeInput.disabled = !this.hasTime;

		this.timeToggle.addEventListener("change", () => {
			this.setHasTime(this.timeToggle.checked);
			if (this.hasTime) this.syncTimeFromInput();
		});
		this.timeInput.addEventListener("input", () => {
			this.syncTimeFromInput();
			this.updatePreview();
		});

		const footer = this.root.createDiv({ cls: "now-dp-footer" });
		const submitBtn = footer.createEl("button", {
			cls: "now-dp-action mod-cta",
			text: this.mode === "edit" ? "Update" : "Insert",
		});
		submitBtn.addEventListener("click", () => this.submit());
	}

	private toggleFormatList(force?: boolean): void {
		this.formatListOpen = force ?? !this.formatListOpen;
		this.formatList.style.display = this.formatListOpen ? "block" : "none";
		this.reposition(this.anchor);
	}

	private timeString(): string {
		const h = this.selected.getHours();
		const m = this.selected.getMinutes();
		return `${h < 10 ? "0" + h : h}:${m < 10 ? "0" + m : m}`;
	}

	private syncTimeFromInput(): void {
		const parts = this.timeInput.value.split(":");
		if (parts.length === 2) {
			const h = Number(parts[0]);
			const m = Number(parts[1]);
			if (!isNaN(h) && !isNaN(m)) this.selected.setHours(h, m, 0, 0);
		}
	}

	private shiftMonth(delta: number): void {
		this.viewDate = new Date(
			this.viewDate.getFullYear(),
			this.viewDate.getMonth() + delta,
			1
		);
		this.renderMonth();
	}

	private renderMonth(): void {
		this.headerLabel.setText(
			`${MONTH_NAMES_FULL[this.viewDate.getMonth()]} ${this.viewDate.getFullYear()}`
		);
		this.gridEl.empty();

		const year = this.viewDate.getFullYear();
		const month = this.viewDate.getMonth();
		const firstWeekday = new Date(year, month, 1).getDay();
		const daysInMonth = new Date(year, month + 1, 0).getDate();
		const today = new Date();

		for (let i = 0; i < firstWeekday; i++) {
			this.gridEl.createDiv({ cls: "now-dp-day now-dp-empty" });
		}
		for (let day = 1; day <= daysInMonth; day++) {
			const cellDate = new Date(year, month, day);
			const cell = this.gridEl.createDiv({
				cls: "now-dp-day",
				text: String(day),
			});
			if (isSameDay(cellDate, today)) cell.addClass("now-dp-today");
			if (isSameDay(cellDate, this.selected)) cell.addClass("now-dp-selected");
			cell.addEventListener("click", () => {
				this.selected.setFullYear(year, month, day);
				this.submit();
			});
		}
	}

	private updatePreview(message?: string): void {
		if (message) {
			this.previewEl.setText(message);
			return;
		}
		this.previewEl.setText(
			formatDisplay(this.selected, this.hasTime, this.format)
		);
	}

	private reposition(coords: DatePickerOptions["coords"]): void {
		this.anchor = coords;
		const rect = this.root.getBoundingClientRect();
		const margin = 4;
		let left = coords.left;
		let top = coords.bottom + margin;
		if (top + rect.height > window.innerHeight - margin) {
			top = coords.top - rect.height - margin;
		}
		if (top < margin) top = margin;
		if (left + rect.width > window.innerWidth - margin) {
			left = window.innerWidth - rect.width - margin;
		}
		if (left < margin) left = margin;
		this.root.style.left = `${Math.round(left)}px`;
		this.root.style.top = `${Math.round(top)}px`;
	}

	close(cancelled: boolean): void {
		document.removeEventListener("mousedown", this.onDocMouseDown, true);
		document.removeEventListener("keydown", this.onKeyDown, true);
		window.removeEventListener("resize", this.onReposition);
		window.removeEventListener("scroll", this.onReposition, true);
		this.root.remove();
		if (cancelled && !this.submitted) this.onCancel();
	}
}
