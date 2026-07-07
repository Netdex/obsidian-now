import * as crypto from "crypto";
import { DateTime } from "luxon";
import {
	dateTokenRegexGlobal,
	parseToken,
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
	fireMillis: number; // absolute instant the reminder should fire
	fireISO: string;
	eventHuman: string; // human-friendly event string for the notification body
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
	const zone = tz ?? defaultZone ?? undefined;
	const base = DateTime.fromObject(
		{ year, month, day, hour: hasTime ? hour : 0, minute: hasTime ? minute : 0 },
		zone ? { zone } : {}
	);
	if (!base.isValid) return null;
	const at9 = (dt: DateTime) => dt.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
	switch (reminder) {
		case "at":
			return hasTime ? base : null;
		case "m5":
			return hasTime ? base.minus({ minutes: 5 }) : null;
		case "m10":
			return hasTime ? base.minus({ minutes: 10 }) : null;
		case "m15":
			return hasTime ? base.minus({ minutes: 15 }) : null;
		case "m30":
			return hasTime ? base.minus({ minutes: 30 }) : null;
		case "h1":
			return hasTime ? base.minus({ hours: 1 }) : null;
		case "h2":
			return hasTime ? base.minus({ hours: 2 }) : null;
		case "day":
			return at9(base);
		case "d1":
			return at9(base.minus({ days: 1 }));
		case "d2":
			return at9(base.minus({ days: 2 }));
		case "w1":
			return at9(base.minus({ days: 7 }));
		default:
			return null; // "none"
	}
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
		});
	}
	return out;
}
