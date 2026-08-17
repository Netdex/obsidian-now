import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
	DEFAULT_REPEAT,
	dueOccurrence,
	extractReminders,
	nextOccurrence,
} from "../src/reminders";

const NY = "America/New_York";

// A 2026 New York instant, for readable expectations.
function at(month: number, day: number, hour: number, minute = 0): number {
	return DateTime.fromObject({ year: 2026, month, day, hour, minute }, { zone: NY }).toMillis();
}

test("date-only 'd1' fires 09:00 the day before, in the default zone", () => {
	const rs = extractReminders("note.md", "task @2026-03-23~rel~r=d1 done", NY);
	assert.equal(rs.length, 1);
	const expected = DateTime.fromObject(
		{ year: 2026, month: 3, day: 22, hour: 9 },
		{ zone: NY }
	).toMillis();
	assert.equal(rs[0].fireMillis, expected);
	assert.equal(rs[0].reminder, "d1");
});

test("a graph-linked date (@[[..]]) is parsed like a plain one", () => {
	const rs = extractReminders("note.md", "task @[[2026-03-23]]~rel~r=d1 done", NY);
	assert.equal(rs.length, 1);
	const expected = DateTime.fromObject(
		{ year: 2026, month: 3, day: 22, hour: 9 },
		{ zone: NY }
	).toMillis();
	assert.equal(rs[0].fireMillis, expected);
	assert.equal(rs[0].reminder, "d1");
});

test("a plain @date inside an unrelated wikilink keeps that link's brackets", () => {
	// The token must not swallow the closing "]]" of the surrounding link.
	const rs = extractReminders("note.md", "see [[Meeting @2026-03-23~r=day]] here", NY);
	assert.equal(rs.length, 1);
	assert.equal(rs[0].raw, "@2026-03-23~r=day");
});

test("date-only 'w1' fires 09:00 one week before", () => {
	const rs = extractReminders("n.md", "@2026-03-23~r=w1", NY);
	const expected = DateTime.fromObject(
		{ year: 2026, month: 3, day: 16, hour: 9 },
		{ zone: NY }
	).toMillis();
	assert.equal(rs[0].fireMillis, expected);
});

test("timed 'm30' fires 30 minutes before the event, honouring token tz", () => {
	const rs = extractReminders("n.md", "@2026-03-23 09:00~t12~z=America/New_York~r=m30", null);
	const expected = DateTime.fromObject(
		{ year: 2026, month: 3, day: 23, hour: 8, minute: 30 },
		{ zone: NY }
	).toMillis();
	assert.equal(rs[0].fireMillis, expected);
});

test("timed 'at' fires exactly at the event", () => {
	const rs = extractReminders("n.md", "@2026-03-23 14:00~t24~z=America/New_York~r=at", null);
	const expected = DateTime.fromObject(
		{ year: 2026, month: 3, day: 23, hour: 14 },
		{ zone: NY }
	).toMillis();
	assert.equal(rs[0].fireMillis, expected);
});

test("time-based reminder on a date without a time is ignored", () => {
	assert.equal(extractReminders("n.md", "@2026-03-23~r=m30", NY).length, 0);
});

test("tokens without a reminder are ignored", () => {
	assert.equal(extractReminders("n.md", "@2026-03-23~rel and @2026-01-01", NY).length, 0);
});

test("a reminder on a completed task ('- [x]') is skipped", () => {
	assert.equal(
		extractReminders("n.md", "- [x] pay rent @2026-03-23~rel~r=d1", NY).length,
		0
	);
	// Uppercase marker counts as done too.
	assert.equal(
		extractReminders("n.md", "- [X] pay rent @2026-03-23~rel~r=d1", NY).length,
		0
	);
});

test("a reminder on an unchecked or non-'x' task still fires", () => {
	assert.equal(
		extractReminders("n.md", "- [ ] pay rent @2026-03-23~rel~r=d1", NY).length,
		1
	);
	// "[/]" (in progress) and "[-]" (cancelled) are not "completed".
	assert.equal(
		extractReminders("n.md", "- [/] pay rent @2026-03-23~rel~r=d1", NY).length,
		1
	);
});

test("only the completed task line is skipped in a mixed list", () => {
	const content =
		"- [x] done @2026-03-23~rel~r=day\n- [ ] todo @2026-03-24~rel~r=day\n";
	const rs = extractReminders("n.md", content, NY);
	assert.equal(rs.length, 1);
	assert.match(rs[0].lineText, /todo/);
});

test("only task lines repeat daily", () => {
	const [task] = extractReminders("n.md", "- [ ] pay rent @2026-03-23~rel~r=d1", NY);
	assert.equal(task.repeatDaily, true);
	const [other] = extractReminders("n.md", "meeting @2026-03-23~rel~r=d1", NY);
	assert.equal(other.repeatDaily, false);
});

test("an open task's reminder repeats daily at the configured hour", () => {
	const [r] = extractReminders("n.md", "- [ ] pay rent @2026-03-23~rel~r=d1", NY);
	// Fires 09:00 NY on the 22nd; two and a half days later it is on repeat 2.
	const now = DateTime.fromObject({ year: 2026, month: 3, day: 24, hour: 21 }, { zone: NY });
	assert.deepEqual(dueOccurrence(r, now.toMillis(), DEFAULT_REPEAT), {
		index: 2,
		millis: at(3, 24, 9),
	});
});

test("repeats move a timed reminder to the nag hour", () => {
	// The event reminder itself fires at 08:30; the nags land at 09:00 after.
	const [r] = extractReminders("n.md", "- [ ] standup @2026-03-23 09:00~t24~r=m30", NY);
	assert.equal(r.fireMillis, at(3, 23, 8, 30));
	const now = at(3, 25, 12);
	assert.deepEqual(dueOccurrence(r, now, DEFAULT_REPEAT), { index: 2, millis: at(3, 25, 9) });
});

test("repeat.atHour null keeps the original time of day", () => {
	const [r] = extractReminders("n.md", "- [ ] standup @2026-03-23 09:00~t24~r=m30", NY);
	const repeat = { ...DEFAULT_REPEAT, atHour: null };
	assert.deepEqual(dueOccurrence(r, at(3, 25, 12), repeat), { index: 2, millis: at(3, 25, 8, 30) });
});

test("repeat.maxDays stops the nagging", () => {
	const [r] = extractReminders("n.md", "- [ ] pay rent @2026-03-23~rel~r=d1", NY);
	const repeat = { ...DEFAULT_REPEAT, maxDays: 2 };
	assert.deepEqual(dueOccurrence(r, at(3, 24, 12), repeat), { index: 2, millis: at(3, 24, 9) });
	assert.equal(dueOccurrence(r, at(3, 25, 12), repeat), null);
	assert.equal(nextOccurrence(r, at(3, 25, 12), repeat), null);
});

test("repeat.enabled false makes a task fire exactly once", () => {
	const [r] = extractReminders("n.md", "- [ ] pay rent @2026-03-23~rel~r=d1", NY);
	const repeat = { ...DEFAULT_REPEAT, enabled: false };
	assert.deepEqual(dueOccurrence(r, at(3, 25, 12), repeat), { index: 0, millis: r.fireMillis });
	assert.equal(nextOccurrence(r, at(3, 25, 12), repeat), null);
});

test("daily repeats hold their local time across a DST transition", () => {
	// US DST starts 2026-03-08, so the 7th -> 8th day is only 23 hours long.
	const [r] = extractReminders("n.md", "- [ ] file taxes @2026-03-08~rel~r=d1", NY);
	assert.deepEqual(dueOccurrence(r, at(3, 9, 12), DEFAULT_REPEAT), {
		index: 2,
		millis: at(3, 9, 9),
	});
});

test("nothing is due before the first fire time", () => {
	const [r] = extractReminders("n.md", "- [ ] pay rent @2026-03-23~rel~r=d1", NY);
	assert.equal(dueOccurrence(r, r.fireMillis - 1000, DEFAULT_REPEAT), null);
	assert.deepEqual(dueOccurrence(r, r.fireMillis, DEFAULT_REPEAT), {
		index: 0,
		millis: r.fireMillis,
	});
	// ...but it is the next thing coming.
	assert.deepEqual(nextOccurrence(r, r.fireMillis - 1000, DEFAULT_REPEAT), {
		index: 0,
		millis: r.fireMillis,
	});
});

test("a non-task reminder never advances past its first firing", () => {
	const [r] = extractReminders("n.md", "meeting @2026-03-23~rel~r=d1", NY);
	const later = r.fireMillis + 10 * 24 * 60 * 60 * 1000;
	assert.deepEqual(dueOccurrence(r, later, DEFAULT_REPEAT), { index: 0, millis: r.fireMillis });
	assert.equal(nextOccurrence(r, later, DEFAULT_REPEAT), null);
});

test("captures the line and multiple reminders", () => {
	const content = "line1\n- meeting @2026-03-23 09:00~t12~r=h1\n- @2026-03-23~r=day\n";
	const rs = extractReminders("n.md", content, NY);
	assert.equal(rs.length, 2);
	assert.equal(rs[0].line, 2);
	assert.match(rs[0].lineText, /meeting/);
});
