import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { extractReminders } from "../src/reminders";

const NY = "America/New_York";

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

test("captures the line and multiple reminders", () => {
	const content = "line1\n- meeting @2026-03-23 09:00~t12~r=h1\n- @2026-03-23~r=day\n";
	const rs = extractReminders("n.md", content, NY);
	assert.equal(rs.length, 2);
	assert.equal(rs[0].line, 2);
	assert.match(rs[0].lineText, /meeting/);
});
