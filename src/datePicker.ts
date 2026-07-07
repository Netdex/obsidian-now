import { formatToken, isSameDay } from "./dateUtils";

export interface DatePickerOptions {
	// Screen coordinates to anchor the popup to (usually the caret / clicked pill).
	coords: { left: number; top: number; bottom: number };
	// Initial selection.
	initialDate: Date;
	initialHasTime: boolean;
	// Called when the user commits a date. `token` is the full "@..." string.
	onSubmit: (token: string, date: Date, hasTime: boolean) => void;
	// Called when the picker is dismissed without committing.
	onCancel: () => void;
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

const WEEKDAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// A self-contained floating calendar popup, styled to feel native to Obsidian.
// Only one should exist at a time; the plugin owns its lifecycle.
export class DatePicker {
	private root: HTMLElement;
	private gridEl!: HTMLElement;
	private headerLabel!: HTMLElement;
	private timeInput!: HTMLInputElement;
	private timeToggle!: HTMLInputElement;

	private viewDate: Date; // which month is shown
	private selected: Date; // currently selected day/time
	private hasTime: boolean;
	private submitted = false;

	private onSubmit: DatePickerOptions["onSubmit"];
	private onCancel: DatePickerOptions["onCancel"];

	private readonly onDocMouseDown = (e: MouseEvent) => {
		if (!this.root.contains(e.target as Node)) this.close(true);
	};
	private readonly onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			this.close(true);
		} else if (e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			this.submit();
		}
	};
	private readonly onReposition = () => this.reposition(this.anchor);

	private anchor: DatePickerOptions["coords"];

	constructor(opts: DatePickerOptions) {
		this.selected = new Date(opts.initialDate.getTime());
		this.viewDate = new Date(
			this.selected.getFullYear(),
			this.selected.getMonth(),
			1
		);
		this.hasTime = opts.initialHasTime;
		this.onSubmit = opts.onSubmit;
		this.onCancel = opts.onCancel;
		this.anchor = opts.coords;

		this.root = document.createElement("div");
		this.root.className = "now-datepicker";
		// Keep clicks inside from stealing/altering the editor selection.
		this.root.addEventListener("mousedown", (e) => e.preventDefault());
		document.body.appendChild(this.root);

		this.buildDom();
		this.renderMonth();
		this.reposition(this.anchor);

		document.addEventListener("mousedown", this.onDocMouseDown, true);
		document.addEventListener("keydown", this.onKeyDown, true);
		window.addEventListener("resize", this.onReposition);
		window.addEventListener("scroll", this.onReposition, true);
	}

	private buildDom(): void {
		// --- Header: prev, month label, next ---
		const header = this.root.createDiv({ cls: "now-dp-header" });
		const prev = header.createEl("button", {
			cls: "now-dp-nav",
			text: "‹",
		});
		prev.setAttr("aria-label", "Previous month");
		prev.addEventListener("click", () => this.shiftMonth(-1));

		this.headerLabel = header.createDiv({ cls: "now-dp-title" });

		const next = header.createEl("button", {
			cls: "now-dp-nav",
			text: "›",
		});
		next.setAttr("aria-label", "Next month");
		next.addEventListener("click", () => this.shiftMonth(1));

		// --- Weekday row ---
		const weekRow = this.root.createDiv({ cls: "now-dp-weekdays" });
		for (const w of WEEKDAY_NAMES) {
			weekRow.createDiv({ cls: "now-dp-weekday", text: w });
		}

		// --- Day grid ---
		this.gridEl = this.root.createDiv({ cls: "now-dp-grid" });

		// --- Time row ---
		const timeRow = this.root.createDiv({ cls: "now-dp-time" });
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
			this.hasTime = this.timeToggle.checked;
			this.timeInput.disabled = !this.hasTime;
			if (this.hasTime && !this.timeInput.value) {
				this.timeInput.value = this.timeString();
			}
			this.syncTimeFromInput();
		});
		this.timeInput.addEventListener("input", () => this.syncTimeFromInput());

		// --- Footer actions ---
		const footer = this.root.createDiv({ cls: "now-dp-footer" });
		const todayBtn = footer.createEl("button", {
			cls: "now-dp-action",
			text: "Today",
		});
		todayBtn.addEventListener("click", () => {
			const now = new Date();
			this.selected.setFullYear(
				now.getFullYear(),
				now.getMonth(),
				now.getDate()
			);
			this.viewDate = new Date(now.getFullYear(), now.getMonth(), 1);
			this.renderMonth();
		});

		const submitBtn = footer.createEl("button", {
			cls: "now-dp-action mod-cta",
			text: "Insert",
		});
		submitBtn.addEventListener("click", () => this.submit());
	}

	private timeString(): string {
		const h =
			this.selected.getHours() < 10
				? "0" + this.selected.getHours()
				: String(this.selected.getHours());
		const m =
			this.selected.getMinutes() < 10
				? "0" + this.selected.getMinutes()
				: String(this.selected.getMinutes());
		return `${h}:${m}`;
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
			`${MONTH_NAMES[this.viewDate.getMonth()]} ${this.viewDate.getFullYear()}`
		);
		this.gridEl.empty();

		const year = this.viewDate.getFullYear();
		const month = this.viewDate.getMonth();
		const firstWeekday = new Date(year, month, 1).getDay();
		const daysInMonth = new Date(year, month + 1, 0).getDate();
		const today = new Date();

		// Leading blanks so the 1st lands under its weekday column.
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
			if (isSameDay(cellDate, this.selected))
				cell.addClass("now-dp-selected");
			cell.addEventListener("click", () => {
				this.selected.setFullYear(year, month, day);
				// Re-selecting a day commits immediately, like Notion.
				this.submit();
			});
		}
	}

	private submit(): void {
		if (this.hasTime) this.syncTimeFromInput();
		this.submitted = true;
		const token = formatToken(this.selected, this.hasTime);
		this.close(false);
		this.onSubmit(token, new Date(this.selected.getTime()), this.hasTime);
	}

	private reposition(coords: DatePickerOptions["coords"]): void {
		this.anchor = coords;
		const rect = this.root.getBoundingClientRect();
		const margin = 4;
		let left = coords.left;
		let top = coords.bottom + margin;

		// Flip above the caret if there is no room below.
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

	// Removes the popup and detaches listeners. If `cancelled`, fires onCancel.
	close(cancelled: boolean): void {
		document.removeEventListener("mousedown", this.onDocMouseDown, true);
		document.removeEventListener("keydown", this.onKeyDown, true);
		window.removeEventListener("resize", this.onReposition);
		window.removeEventListener("scroll", this.onReposition, true);
		this.root.remove();
		if (cancelled && !this.submitted) this.onCancel();
	}
}
