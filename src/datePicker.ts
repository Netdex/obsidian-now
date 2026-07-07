import {
	COMMON_TIMEZONES,
	DateFormat,
	DATE_FORMAT_LABELS,
	DATE_FORMAT_ORDER,
	MONTH_NAMES_FULL,
	REMINDER_LABELS,
	ReminderCode,
	TimeFormat,
	WEEKDAY_HEADERS,
	formatPill,
	isSameDay,
	isValidReminder,
	reminderOptionsFor,
	tzMenuLabel,
} from "./dateUtils";

export interface PickerValue {
	date: Date;
	hasTime: boolean;
	format: DateFormat;
	timeFormat: TimeFormat;
	tz: string | null;
	reminder: ReminderCode;
}

export interface DatePickerOptions {
	coords: { left: number; top: number; bottom: number };
	initialDate: Date;
	initialHasTime: boolean;
	initialFormat: DateFormat;
	initialTimeFormat: TimeFormat;
	initialTz: string | null;
	initialReminder: ReminderCode;
	// "new" is used while typing inline (editor keeps focus, plugin drives keys);
	// "edit" is used when a pill is clicked (picker handles its own keys).
	mode: "new" | "edit";
	onSubmit: (value: PickerValue) => void;
	onClear: () => void;
	onCancel: () => void;
}

interface MenuOption {
	value: string;
	label: string;
}

interface MenuHandle {
	valueEl: HTMLElement;
	refresh: () => void;
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

	private fmtMenu!: MenuHandle;
	private timeMenu!: MenuHandle;
	private tzMenu!: MenuHandle;
	private remindMenu!: MenuHandle;

	private viewDate: Date;
	private selected: Date;
	private hasTime: boolean;
	private format: DateFormat;
	private timeFormat: TimeFormat;
	private tz: string | null;
	private reminder: ReminderCode;
	private readonly mode: "new" | "edit";
	private submitted = false;

	private onSubmit: DatePickerOptions["onSubmit"];
	private onClear: DatePickerOptions["onClear"];
	private onCancel: DatePickerOptions["onCancel"];
	private anchor: DatePickerOptions["coords"];

	private readonly onDocMouseDown = (e: MouseEvent) => {
		if (!this.root.contains(e.target as Node)) this.close(true);
	};
	private readonly onKeyDown = (e: KeyboardEvent) => {
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
		this.timeFormat = opts.initialTimeFormat;
		this.tz = opts.initialTz;
		this.reminder = opts.initialReminder;
		this.mode = opts.mode;
		this.onSubmit = opts.onSubmit;
		this.onClear = opts.onClear;
		this.onCancel = opts.onCancel;
		this.anchor = opts.coords;

		this.root = document.createElement("div");
		this.root.className = "now-datepicker";
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
			timeFormat: this.timeFormat,
			tz: this.tz,
			reminder: this.reminder,
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
		this.refreshMenus();
		this.updatePreview();
	}

	setHasTime(hasTime: boolean): void {
		this.hasTime = hasTime;
		this.timeToggle.checked = hasTime;
		this.timeInput.disabled = !hasTime;
		if (hasTime) this.timeInput.value = this.timeString();
		// Some reminders only make sense with/without a time; drop if invalid.
		if (!isValidReminder(this.reminder, hasTime)) this.reminder = "none";
		this.refreshMenus();
		this.updatePreview();
	}

	setFormat(format: DateFormat): void {
		this.format = format;
		this.refreshMenus();
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

		const nowBtn = header.createEl("button", { cls: "now-dp-now", text: "Now" });
		nowBtn.addEventListener("click", () => this.setSelectedDate(new Date()));

		const next = header.createEl("button", { cls: "now-dp-nav", text: ">" });
		next.setAttr("aria-label", "Next month");
		next.addEventListener("click", () => this.shiftMonth(1));

		const weekRow = this.root.createDiv({ cls: "now-dp-weekdays" });
		for (const w of WEEKDAY_HEADERS) {
			weekRow.createDiv({ cls: "now-dp-weekday", text: w });
		}

		this.gridEl = this.root.createDiv({ cls: "now-dp-grid" });

		// Date format menu.
		this.fmtMenu = this.addMenuRow(
			"Date format",
			() => DATE_FORMAT_LABELS[this.format],
			() => DATE_FORMAT_ORDER.map((f) => ({ value: f, label: DATE_FORMAT_LABELS[f] })),
			() => this.format,
			(v) => this.setFormat(v as DateFormat)
		);

		// Include time toggle.
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
		this.timeToggle.addEventListener("change", () =>
			this.setHasTime(this.timeToggle.checked)
		);
		this.timeInput.addEventListener("input", () => {
			this.syncTimeFromInput();
			this.updatePreview();
		});

		// Time format menu (Hidden collapses to no time).
		this.timeMenu = this.addMenuRow(
			"Time format",
			() => (this.hasTime ? (this.timeFormat === "24" ? "24 hour" : "12 hour") : "Hidden"),
			() => [
				{ value: "hidden", label: "Hidden" },
				{ value: "12", label: "12 hour" },
				{ value: "24", label: "24 hour" },
			],
			() => (this.hasTime ? this.timeFormat : "hidden"),
			(v) => {
				if (v === "hidden") {
					this.setHasTime(false);
				} else {
					this.timeFormat = v as TimeFormat;
					this.setHasTime(true);
				}
			}
		);

		// Timezone menu.
		this.tzMenu = this.addMenuRow(
			"Timezone",
			() => tzMenuLabel(this.tz),
			() => [
				{ value: "local", label: "Local" },
				...COMMON_TIMEZONES.map((z) => ({ value: z, label: tzMenuLabel(z) })),
			],
			() => this.tz ?? "local",
			(v) => {
				this.tz = v === "local" ? null : v;
				this.refreshMenus();
				this.updatePreview();
			}
		);

		// Remind menu (options depend on whether a time is included).
		this.remindMenu = this.addMenuRow(
			"Remind",
			() => REMINDER_LABELS[this.reminder],
			() =>
				reminderOptionsFor(this.hasTime).map((code) => ({
					value: code,
					label: REMINDER_LABELS[code],
				})),
			() => this.reminder,
			(v) => {
				this.reminder = v as ReminderCode;
				this.refreshMenus();
			}
		);

		// Footer: Clear (left) + Insert/Update (right).
		const footer = this.root.createDiv({ cls: "now-dp-footer" });
		const clearBtn = footer.createEl("button", {
			cls: "now-dp-action now-dp-clear",
			text: "Clear",
		});
		clearBtn.addEventListener("click", () => this.clear());
		footer.createDiv({ cls: "now-dp-footer-spacer" });
		const submitBtn = footer.createEl("button", {
			cls: "now-dp-action mod-cta",
			text: this.mode === "edit" ? "Update" : "Insert",
		});
		submitBtn.addEventListener("click", () => this.submit());
	}

	// Builds a "label ... value >" row with a collapsible option list beneath it.
	// `options` is a function so menus (like Remind) can vary with other state.
	private addMenuRow(
		labelText: string,
		valueText: () => string,
		options: () => MenuOption[],
		current: () => string,
		onSelect: (value: string) => void
	): MenuHandle {
		const row = this.root.createDiv({ cls: "now-dp-row now-dp-menu-row" });
		row.createSpan({ cls: "now-dp-row-label", text: labelText });
		const valueEl = row.createSpan({ cls: "now-dp-row-value", text: valueText() });
		row.createSpan({ cls: "now-dp-row-chevron", text: ">" });

		const list = this.root.createDiv({ cls: "now-dp-menu-list" });
		list.style.display = "none";

		const rebuild = () => {
			list.empty();
			const cur = current();
			for (const opt of options()) {
				const item = list.createDiv({ cls: "now-dp-menu-item", text: opt.label });
				item.toggleClass("now-dp-menu-current", opt.value === cur);
				item.addEventListener("click", () => {
					onSelect(opt.value);
					list.style.display = "none";
					this.reposition(this.anchor);
				});
			}
		};

		row.addEventListener("click", (e) => {
			if (list.contains(e.target as Node)) return;
			const open = list.style.display === "none";
			// Collapse any other open menus for a tidy single-open behaviour.
			this.root.findAll(".now-dp-menu-list").forEach((el) => {
				(el as HTMLElement).style.display = "none";
			});
			if (open) rebuild();
			list.style.display = open ? "block" : "none";
			this.reposition(this.anchor);
		});

		return { valueEl, refresh: () => valueEl.setText(valueText()) };
	}

	private refreshMenus(): void {
		this.fmtMenu.refresh();
		this.timeMenu.refresh();
		this.tzMenu.refresh();
		this.remindMenu.refresh();
	}

	private clear(): void {
		this.submitted = true;
		this.close(false);
		this.onClear();
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
			const cell = this.gridEl.createDiv({ cls: "now-dp-day", text: String(day) });
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
			formatPill(this.selected, this.hasTime, {
				format: this.format,
				timeFormat: this.timeFormat,
				tz: this.tz,
			})
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
