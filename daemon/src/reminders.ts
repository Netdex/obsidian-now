import * as crypto from "crypto";
import { DateTime } from "luxon";
import {
	dateTokenRegexGlobal,
	isCompletedTaskLine,
	isTaskLine,
	parseToken,
	reminderOffset,
	ReminderCode,
	REMINDER_LABELS,
} from "obsidian-now-datecore";

// The token grammar and parsing come from the shared datecore package (the same
// code the plugin uses). This file only adds the timezone-aware fire-time
// computation, which needs luxon and is daemon-specific.
export { REMINDER_LABELS };
export type { ReminderCode };

export interface Reminder {
	id: string; // stable identity for de-duplication across rescans/restarts
	filePath: string;
	line: number;
	lineText: string;
	raw: string;
	reminder: ReminderCode;
	eventISO: string; // canonical event stamp, tz-independent (used in the id)
	fireMillis: number; // absolute instant the reminder should first fire
	fireISO: string;
	eventHuman: string; // human-friendly event string for the notification body
	zone: string | null; // zone the fire time was computed in (for daily repeats)
	repeatDaily: boolean; // open task -> repeat at the same local time each day
}

// One firing of a reminder: index 0 is the original fire time, index N the Nth
// daily repeat of an open task.
export interface Occurrence {
	index: number;
	millis: number;
}

// How an open task's reminder repeats until the task is completed.
export interface RepeatConfig {
	enabled: boolean;
	// Local hour the daily repeats fire at; null keeps the original fire time
	// of day (e.g. a "30 minutes before" reminder nags at that same time).
	atHour: number | null;
	// Stop repeating this many days after the first firing; null = never stop.
	maxDays: number | null;
}

export const DEFAULT_REPEAT: RepeatConfig = { enabled: true, atHour: 9, maxDays: null };

const DAY_MS = 24 * 60 * 60 * 1000;

function repeats(r: Reminder, repeat: RepeatConfig): boolean {
	return r.repeatDaily && repeat.enabled;
}

// Absolute instant of the Nth firing: 0 is the original fire time, N >= 1 the
// Nth daily repeat. Days are stepped with luxon rather than by adding 24h so a
// repeat keeps its local time across DST transitions.
function occurrenceMillis(r: Reminder, index: number, repeat: RepeatConfig): number {
	if (index === 0) return r.fireMillis;
	const zone = r.zone ?? undefined;
	const day = DateTime.fromMillis(r.fireMillis, zone ? { zone } : {}).plus({ days: index });
	const at =
		repeat.atHour === null
			? day
			: day.set({ hour: repeat.atHour, minute: 0, second: 0, millisecond: 0 });
	return at.toMillis();
}

// Index of the last firing at or before `nowMillis` (assumes the reminder is
// due and repeating). Occurrences are strictly increasing in the index, so a
// cheap estimate plus correction is enough -- and stays O(1) for a task that
// has been open for years.
function latestIndex(r: Reminder, nowMillis: number, repeat: RepeatConfig): number {
	const at = (i: number) => occurrenceMillis(r, i, repeat);
	// The estimate can be off by a day either way: DST makes some days 23h/25h
	// long, and `atHour` shifts every repeat off the original time of day.
	let index = Math.floor((nowMillis - r.fireMillis) / DAY_MS);
	while (index > 0 && at(index) > nowMillis) index--;
	while (at(index + 1) <= nowMillis) index++;
	return index;
}

function beyondMaxDays(index: number, repeat: RepeatConfig): boolean {
	return repeat.maxDays !== null && index > repeat.maxDays;
}

// The firing that is currently due, or null if none is (not due yet, or the
// task has been nagged about for longer than `maxDays`).
export function dueOccurrence(
	r: Reminder,
	nowMillis: number,
	repeat: RepeatConfig
): Occurrence | null {
	if (nowMillis < r.fireMillis) return null;
	if (!repeats(r, repeat)) return { index: 0, millis: r.fireMillis };
	const index = latestIndex(r, nowMillis, repeat);
	if (beyondMaxDays(index, repeat)) return null;
	return { index, millis: occurrenceMillis(r, index, repeat) };
}

// The next firing strictly after `nowMillis`, or null if there will be none.
// Used by --list to show what is still coming.
export function nextOccurrence(
	r: Reminder,
	nowMillis: number,
	repeat: RepeatConfig
): Occurrence | null {
	if (nowMillis < r.fireMillis) return { index: 0, millis: r.fireMillis };
	if (!repeats(r, repeat)) return null;
	const index = latestIndex(r, nowMillis, repeat) + 1;
	if (beyondMaxDays(index, repeat)) return null;
	return { index, millis: occurrenceMillis(r, index, repeat) };
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

// Computes the absolute instant a reminder fires, honouring the event's
// timezone (or the provided default). Returns null for invalid combinations
// (e.g. a time-based reminder on a date without a time).
function computeFire(
	year: number,
	month: number,
	day: number,
	hasTime: boolean,
	hour: number,
	minute: number,
	tz: string | null,
	reminder: ReminderCode,
	defaultZone: string | null
): DateTime | null {
	const off = reminderOffset(reminder);
	if (!off) return null;
	const zone = tz ?? defaultZone ?? undefined;
	const base = DateTime.fromObject(
		{ year, month, day, hour: hasTime ? hour : 0, minute: hasTime ? minute : 0 },
		zone ? { zone } : {}
	);
	if (!base.isValid) return null;
	if (off.kind === "at") return hasTime ? base : null;
	if (off.kind === "minutes") return hasTime ? base.minus({ minutes: off.minutes }) : null;
	return base
		.minus({ days: off.days })
		.set({ hour: off.atHour, minute: 0, second: 0, millisecond: 0 });
}

function humanEvent(
	year: number,
	month: number,
	day: number,
	hasTime: boolean,
	hour: number,
	minute: number,
	tz: string | null,
	defaultZone: string | null
): string {
	const zone = tz ?? defaultZone ?? undefined;
	const dt = DateTime.fromObject(
		{ year, month, day, hour: hasTime ? hour : 0, minute: hasTime ? minute : 0 },
		zone ? { zone } : {}
	);
	let s = dt.toLocaleString(hasTime ? DateTime.DATETIME_MED : DateTime.DATE_MED);
	if (tz) s += ` ${dt.toFormat("ZZZZ")}`;
	return s;
}

function makeId(filePath: string, eventISO: string, code: string, fireISO: string): string {
	return crypto
		.createHash("sha1")
		.update(`${filePath}|${eventISO}|${code}|${fireISO}`)
		.digest("hex")
		.slice(0, 16);
}

// Extracts all fire-able reminders from a note's content.
export function extractReminders(
	filePath: string,
	content: string,
	defaultZone: string | null
): Reminder[] {
	const out: Reminder[] = [];
	const re = dateTokenRegexGlobal();
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		const parsed = parseToken(m[0]);
		if (!parsed || parsed.reminder === "none") continue;

		const d = parsed.date;
		const [year, month, day] = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
		const [hour, minute] = [d.getHours(), d.getMinutes()];
		const fire = computeFire(
			year, month, day, parsed.hasTime, hour, minute, parsed.tz, parsed.reminder, defaultZone
		);
		if (!fire || !fire.isValid) continue;

		const eventISO = parsed.hasTime
			? `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`
			: `${year}-${pad(month)}-${pad(day)}`;
		const fireISO = fire.toISO() ?? String(fire.toMillis());
		const line = content.slice(0, m.index).split("\n").length;
		const lineText = content.split("\n")[line - 1]?.trim() ?? "";

		// A completed task's date is settled -- don't fire its reminder.
		if (isCompletedTaskLine(lineText)) continue;

		out.push({
			id: makeId(filePath, eventISO, parsed.reminder, fireISO),
			filePath,
			line,
			lineText,
			raw: m[0],
			reminder: parsed.reminder,
			eventISO,
			fireMillis: fire.toMillis(),
			fireISO,
			eventHuman: humanEvent(year, month, day, parsed.hasTime, hour, minute, parsed.tz, defaultZone),
			zone: parsed.tz ?? defaultZone,
			// The line is a task and (checked above) not completed, so keep
			// nagging once a day until it is.
			repeatDaily: isTaskLine(lineText),
		});
	}
	return out;
}
