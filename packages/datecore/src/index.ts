// A date is stored in the document in a canonical, machine-readable form so the
// underlying instant never drifts (relative labels like "Today" are recomputed
// on render, so they can't go stale). Per-date display preferences are encoded
// as hidden "~" suffix segments that the pill widget hides from view:
//
//   @2026-07-05                     -> absolute, shown as ISO 2026-07-05
//   @2026-07-05~rel                 -> shown relative, e.g. "Monday"
//   @2026-07-05 09:00~full~t12      -> "July 5, 2026 9:00 AM"
//   @2026-07-05 09:00~rel~t24~z=America/New_York -> "Monday 09:00 EDT"
//
// Segments: date format (rel/full/short/mdy/dmy/ymd; iso = none),
// time format (t12/t24), timezone (z=<IANA>). The suffix is only ever seen by
// someone opening the note without this plugin.

export type DateFormat =
	| "iso"
	| "rel"
	| "full"
	| "short"
	| "mdy"
	| "dmy"
	| "ymd";

export type TimeFormat = "12" | "24";

export interface DisplayOpts {
	format: DateFormat;
	timeFormat: TimeFormat;
	tz: string | null; // IANA name, or null for local (no label)
}

// Reminder offsets. "none" is the absence of a reminder (never stored).
// Timed offsets (at/m*/h*) require a time on the date; the day-based ones
// (day/d1/d2/w1) fire at 09:00 and apply to any date. This mirrors Notion.
export type ReminderCode =
	| "none"
	| "at"
	| "m5"
	| "m10"
	| "m15"
	| "m30"
	| "h1"
	| "h2"
	| "day"
	| "d1"
	| "d2"
	| "w1";

export const REMINDER_LABELS: Record<ReminderCode, string> = {
	none: "None",
	at: "At time of event",
	m5: "5 minutes before",
	m10: "10 minutes before",
	m15: "15 minutes before",
	m30: "30 minutes before",
	h1: "1 hour before",
	h2: "2 hours before",
	day: "On day of event (9:00 AM)",
	d1: "1 day before (9:00 AM)",
	d2: "2 days before (9:00 AM)",
	w1: "1 week before (9:00 AM)",
};

const REMINDERS_DATEONLY: ReminderCode[] = ["none", "day", "d1", "d2", "w1"];
const REMINDERS_TIMED: ReminderCode[] = [
	"none", "at", "m5", "m10", "m15", "m30", "h1", "h2", "d1", "d2",
];

export function reminderOptionsFor(hasTime: boolean): ReminderCode[] {
	return hasTime ? REMINDERS_TIMED : REMINDERS_DATEONLY;
}

export function isValidReminder(code: ReminderCode, hasTime: boolean): boolean {
	return reminderOptionsFor(hasTime).includes(code);
}

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

// A curated timezone list for the picker menu (plus "Local" = null).
export const COMMON_TIMEZONES = [
	"UTC",
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"America/Toronto",
	"Europe/London",
	"Europe/Paris",
	"Europe/Berlin",
	"Asia/Kolkata",
	"Asia/Shanghai",
	"Asia/Tokyo",
	"Australia/Sydney",
];

// @YYYY-MM-DD [ HH:mm] [~segments]
export const DATE_TOKEN_REGEX =
	/@(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?((?:~(?:rel|full|short|mdy|dmy|ymd|t12|t24|z=[A-Za-z0-9_+\/-]+|r=(?:at|m5|m10|m15|m30|h1|h2|day|d1|d2|w1)))*)/;

export function dateTokenRegexGlobal(): RegExp {
	return new RegExp(DATE_TOKEN_REGEX.source, "g");
}

export const MONTH_NAMES_FULL = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

export const MONTH_NAMES_SHORT = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export const WEEKDAY_NAMES_FULL = [
	"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

export const WEEKDAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export interface ParsedDate {
	date: Date;
	hasTime: boolean;
	format: DateFormat;
	timeFormat: TimeFormat | null; // null -> caller falls back to a default
	tz: string | null;
	reminder: ReminderCode;
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
	opts: DisplayOpts,
	reminder: ReminderCode = "none"
): string {
	let s = "@" + isoDate(date);
	if (hasTime) s += ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (opts.format !== "iso") s += "~" + opts.format;
	if (hasTime) s += opts.timeFormat === "24" ? "~t24" : "~t12";
	if (hasTime && opts.tz) s += "~z=" + opts.tz;
	if (reminder !== "none") s += "~r=" + reminder;
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

	let format: DateFormat = "iso";
	let timeFormat: TimeFormat | null = null;
	let tz: string | null = null;
	let reminder: ReminderCode = "none";
	for (const seg of (m[6] || "").split("~").filter(Boolean)) {
		if (FORMAT_CODES.has(seg)) format = seg as DateFormat;
		else if (seg === "t12") timeFormat = "12";
		else if (seg === "t24") timeFormat = "24";
		else if (seg.startsWith("z=")) tz = seg.slice(2);
		else if (seg.startsWith("r=")) reminder = seg.slice(2) as ReminderCode;
	}
	return { date, hasTime, format, timeFormat, tz, reminder };
}

function relativeLabel(date: Date): string {
	const diff = Math.round(
		(startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / 86400000
	);
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	if (diff === -1) return "Yesterday";
	const weekday = WEEKDAY_NAMES_FULL[date.getDay()];
	if (diff >= 2 && diff <= 6) return weekday;
	if (diff >= 7 && diff <= 13) return "Next " + weekday;
	if (diff <= -2 && diff >= -7) return "Last " + weekday;
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

function timeText(date: Date, timeFormat: TimeFormat): string {
	const h = date.getHours();
	const m = date.getMinutes();
	if (timeFormat === "24") return `${pad(h)}:${pad(m)}`;
	const ampm = h < 12 ? "AM" : "PM";
	let hr = h % 12;
	if (hr === 0) hr = 12;
	return `${hr}:${pad(m)} ${ampm}`;
}

// Short timezone label for a given instant (DST-aware via Intl), e.g. "EDT".
export function tzAbbrev(date: Date, tz: string): string {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			timeZoneName: "short",
			hour: "2-digit",
		}).formatToParts(date);
		return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
	} catch {
		return "";
	}
}

// Friendly menu label for a timezone value ("local" or an IANA name).
export function tzMenuLabel(tz: string | null): string {
	if (!tz) return "Local";
	const city = tz.split("/").pop() ?? tz;
	return city.replace(/_/g, " ");
}

// The human-facing text (no leading "@").
export function formatDisplay(
	date: Date,
	hasTime: boolean,
	opts: DisplayOpts
): string {
	let s = datePart(date, opts.format);
	if (hasTime) {
		s += " " + timeText(date, opts.timeFormat);
		if (opts.tz) {
			const ab = tzAbbrev(date, opts.tz);
			if (ab) s += " " + ab;
		}
	}
	return s;
}

// What the pill shows: the "@" stays visible even for relative dates.
export function formatPill(
	date: Date,
	hasTime: boolean,
	opts: DisplayOpts
): string {
	return "@" + formatDisplay(date, hasTime, opts);
}

// ---------------------------------------------------------------------------
// Natural-language parsing for inline typing ("@today", "@next friday", ...).
// ---------------------------------------------------------------------------

export interface NLResult {
	date: Date;
	hasTime: boolean;
	relative: boolean; // true -> caller should default the format to "rel"
	format: DateFormat; // suggested format for absolute inputs
}

const WEEKDAYS_LC = WEEKDAY_NAMES_FULL.map((w) => w.toLowerCase());

function weekdayIndex(s: string): number {
	if (s.length < 3) return -1;
	const key = s.slice(0, 3);
	return WEEKDAYS_LC.findIndex((w) => w.slice(0, 3) === key);
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
			return { date: weekdayDate(today, wd, m[1]), hasTime: false, relative: true, format: "rel" };
		}
	}

	m = q.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/);
	if (m) {
		const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
		if (!isNaN(d.getTime())) {
			return { date: d, hasTime: !!m[4], relative: false, format: "iso" };
		}
	}

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

// ---------------------------------------------------------------------------
// Reminder fire-time. The offset semantics are shared here so the plugin (for
// pill colouring) and the daemon (for scheduling) agree; the daemon applies
// them with timezone precision, the plugin uses local time for display.
// ---------------------------------------------------------------------------

export type ReminderOffset =
	| { kind: "at" }
	| { kind: "minutes"; minutes: number }
	| { kind: "days"; days: number; atHour: number };

export function reminderOffset(code: ReminderCode): ReminderOffset | null {
	switch (code) {
		case "at":
			return { kind: "at" };
		case "m5":
			return { kind: "minutes", minutes: 5 };
		case "m10":
			return { kind: "minutes", minutes: 10 };
		case "m15":
			return { kind: "minutes", minutes: 15 };
		case "m30":
			return { kind: "minutes", minutes: 30 };
		case "h1":
			return { kind: "minutes", minutes: 60 };
		case "h2":
			return { kind: "minutes", minutes: 120 };
		case "day":
			return { kind: "days", days: 0, atHour: 9 };
		case "d1":
			return { kind: "days", days: 1, atHour: 9 };
		case "d2":
			return { kind: "days", days: 2, atHour: 9 };
		case "w1":
			return { kind: "days", days: 7, atHour: 9 };
		default:
			return null; // "none"
	}
}

// The reminder's fire time computed in LOCAL time (ignores the token's tz).
// Good enough for display decisions (past vs future); the daemon computes the
// exact, timezone-aware instant separately.
export function reminderFireLocal(parsed: ParsedDate): Date | null {
	const off = reminderOffset(parsed.reminder);
	if (!off) return null;
	if (off.kind === "at") {
		return parsed.hasTime ? new Date(parsed.date.getTime()) : null;
	}
	if (off.kind === "minutes") {
		return parsed.hasTime
			? new Date(parsed.date.getTime() - off.minutes * 60000)
			: null;
	}
	const d = new Date(parsed.date.getTime());
	d.setDate(d.getDate() - off.days);
	d.setHours(off.atHour, 0, 0, 0);
	return d;
}
