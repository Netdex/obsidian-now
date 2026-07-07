// A date is stored in the document in a canonical, machine-readable form so the
// underlying instant never drifts (relative labels like "Today" are recomputed
// on render, so they can't go stale). The per-date display format is encoded as
// a hidden "~code" suffix that the pill widget hides from view:
//
//   @2026-07-05            -> absolute, shown as ISO 2026-07-05
//   @2026-07-05~rel        -> shown relative, e.g. "Today"
//   @2026-07-05 09:00~full -> "July 5, 2026 09:00"
//
// The suffix is only ever seen by someone opening the note without this plugin.

export type DateFormat =
	| "iso"
	| "rel"
	| "full"
	| "short"
	| "mdy"
	| "dmy"
	| "ymd";

// Order + labels for the picker's format menu (Notion-style).
export const DATE_FORMAT_ORDER: DateFormat[] = [
	"rel",
	"full",
	"short",
	"mdy",
	"dmy",
	"ymd",
	"iso",
];

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
	rel: "Relative",
	full: "Full date",
	short: "Short date",
	mdy: "Month/Day/Year",
	dmy: "Day/Month/Year",
	ymd: "Year/Month/Day",
	iso: "ISO",
};

const FORMAT_CODES = new Set<string>(["rel", "full", "short", "mdy", "dmy", "ymd"]);

// @YYYY-MM-DD [ HH:mm] [~code]
export const DATE_TOKEN_REGEX =
	/@(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?(?:~(rel|full|short|mdy|dmy|ymd))?/;

export function dateTokenRegexGlobal(): RegExp {
	return new RegExp(DATE_TOKEN_REGEX.source, "g");
}

export const MONTH_NAMES_FULL = [
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

export const MONTH_NAMES_SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

export const WEEKDAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export interface ParsedDate {
	date: Date;
	hasTime: boolean;
	format: DateFormat;
}

function pad(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

export function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
	const r = new Date(d.getTime());
	r.setDate(r.getDate() + n);
	return r;
}

export function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

function isoDate(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The literal text written into the document (including the leading "@").
export function formatToken(
	date: Date,
	hasTime: boolean,
	format: DateFormat
): string {
	let s = "@" + isoDate(date);
	if (hasTime) s += ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (format !== "iso") s += "~" + format;
	return s;
}

export function parseToken(token: string): ParsedDate | null {
	const m = token.match(DATE_TOKEN_REGEX);
	if (!m) return null;
	const hasTime = m[4] !== undefined && m[5] !== undefined;
	const date = new Date(
		Number(m[1]),
		Number(m[2]) - 1,
		Number(m[3]),
		hasTime ? Number(m[4]) : 0,
		hasTime ? Number(m[5]) : 0,
		0,
		0
	);
	if (isNaN(date.getTime())) return null;
	const code = m[6];
	const format: DateFormat = code && FORMAT_CODES.has(code)
		? (code as DateFormat)
		: "iso";
	return { date, hasTime, format };
}

function relativeLabel(date: Date): string {
	const diff = Math.round(
		(startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / 86400000
	);
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	if (diff === -1) return "Yesterday";
	if (diff > 1 && diff <= 6) return `in ${diff} days`;
	if (diff < -1 && diff >= -6) return `${-diff} days ago`;
	// Far away: fall back to a readable absolute date.
	return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function datePart(date: Date, format: DateFormat): string {
	const y = date.getFullYear();
	const mo = date.getMonth();
	const d = date.getDate();
	switch (format) {
		case "iso":
			return isoDate(date);
		case "ymd":
			return `${y}/${pad(mo + 1)}/${pad(d)}`;
		case "mdy":
			return `${pad(mo + 1)}/${pad(d)}/${y}`;
		case "dmy":
			return `${pad(d)}/${pad(mo + 1)}/${y}`;
		case "full":
			return `${MONTH_NAMES_FULL[mo]} ${d}, ${y}`;
		case "short":
			return `${MONTH_NAMES_SHORT[mo]} ${d}, ${y}`;
		case "rel":
			return relativeLabel(date);
	}
}

// The human-facing text shown inside the pill.
export function formatDisplay(
	date: Date,
	hasTime: boolean,
	format: DateFormat
): string {
	let s = datePart(date, format);
	if (hasTime) s += ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return s;
}

// ---------------------------------------------------------------------------
// Natural-language parsing for inline typing ("@today", "@in 3 days", ...).
// ---------------------------------------------------------------------------

export interface NLResult {
	date: Date;
	hasTime: boolean;
	relative: boolean; // true -> caller should default the format to "rel"
	format: DateFormat; // suggested format for absolute inputs
}

const WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];

function weekdayIndex(s: string): number {
	if (s.length < 3) return -1;
	const key = s.slice(0, 3);
	return WEEKDAYS.findIndex((w) => w.slice(0, 3) === key);
}

function weekdayDate(today: Date, wd: number, mod: string | undefined): Date {
	let diff = (wd - today.getDay() + 7) % 7;
	if (mod === "next") diff = diff === 0 ? 7 : diff;
	else if (mod === "last") diff = diff === 0 ? -7 : diff - 7;
	return addDays(today, diff);
}

function addUnit(base: Date, n: number, unit: string): Date {
	const r = new Date(base.getTime());
	if (unit.startsWith("day")) r.setDate(r.getDate() + n);
	else if (unit.startsWith("week")) r.setDate(r.getDate() + n * 7);
	else if (unit.startsWith("month")) r.setMonth(r.getMonth() + n);
	else if (unit.startsWith("year")) r.setFullYear(r.getFullYear() + n);
	return r;
}

function monthIndex(s: string): number {
	const t = s.replace(/\.$/, "");
	let i = MONTH_NAMES_FULL.findIndex((m) => m.toLowerCase() === t);
	if (i >= 0) return i;
	return MONTH_NAMES_SHORT.findIndex((m) => m.toLowerCase() === t.slice(0, 3));
}

function normYear(y: number): number {
	return y < 100 ? 2000 + y : y;
}

export function parseNaturalDate(input: string): NLResult | null {
	const q = input.trim().toLowerCase();
	if (!q) return null;
	const today = startOfDay(new Date());

	if (q === "now") {
		return { date: new Date(), hasTime: true, relative: true, format: "rel" };
	}
	if (q === "today" || q === "tod") {
		return { date: today, hasTime: false, relative: true, format: "rel" };
	}
	if (q === "tomorrow" || q === "tmr" || q === "tom") {
		return { date: addDays(today, 1), hasTime: false, relative: true, format: "rel" };
	}
	if (q === "yesterday" || q === "yst" || q === "yes") {
		return { date: addDays(today, -1), hasTime: false, relative: true, format: "rel" };
	}

	let m = q.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/);
	if (m) {
		return { date: addUnit(today, +m[1], m[2]), hasTime: false, relative: true, format: "rel" };
	}
	m = q.match(/^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/);
	if (m) {
		return { date: addUnit(today, -+m[1], m[2]), hasTime: false, relative: true, format: "rel" };
	}

	m = q.match(/^(next|last|this)?\s*([a-z]+)$/);
	if (m) {
		const wd = weekdayIndex(m[2]);
		if (wd >= 0) {
			return {
				date: weekdayDate(today, wd, m[1]),
				hasTime: false,
				relative: true,
				format: "rel",
			};
		}
	}

	// Explicit ISO -> keep as ISO.
	m = q.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/);
	if (m) {
		const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
		if (!isNaN(d.getTime())) {
			return { date: d, hasTime: !!m[4], relative: false, format: "iso" };
		}
	}

	// "jul 5", "July 5, 2026"
	m = q.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/);
	if (m) {
		const mi = monthIndex(m[1]);
		if (mi >= 0) {
			const d = new Date(m[3] ? +m[3] : today.getFullYear(), mi, +m[2]);
			if (!isNaN(d.getTime())) {
				return { date: d, hasTime: false, relative: false, format: "short" };
			}
		}
	}
	// "5 jul", "5 July 2026"
	m = q.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/);
	if (m) {
		const mi = monthIndex(m[2]);
		if (mi >= 0) {
			const d = new Date(m[3] ? +m[3] : today.getFullYear(), mi, +m[1]);
			if (!isNaN(d.getTime())) {
				return { date: d, hasTime: false, relative: false, format: "short" };
			}
		}
	}

	// Numeric slashes -> assume Month/Day/Year.
	m = q.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
	if (m) {
		const year = m[3] ? normYear(+m[3]) : today.getFullYear();
		const d = new Date(year, +m[1] - 1, +m[2]);
		if (!isNaN(d.getTime())) {
			return { date: d, hasTime: false, relative: false, format: "mdy" };
		}
	}

	return null;
}
