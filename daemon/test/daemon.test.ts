import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { Config } from "../src/config";
import { ReminderDaemon } from "../src/daemon";
import { Notification } from "../src/pushover";
import { DEFAULT_REPEAT } from "../src/reminders";
import { State } from "../src/state";

const NY = "America/New_York";

function at(month: number, day: number, hour: number, minute = 0): number {
	return DateTime.fromObject({ year: 2026, month, day, hour, minute }, { zone: NY }).toMillis();
}

// In-memory stand-in so the tests never touch the state file on disk.
function fakeState(): State {
	const fired = new Set<string>();
	return {
		load: () => {},
		has: (id: string) => fired.has(id),
		mark: (id: string) => void fired.add(id),
		prune: () => {},
		saveNow: () => {},
	} as unknown as State;
}

function makeConfig(over: Partial<Config> = {}): Config {
	return {
		couch: { url: "http://couch.invalid", database: "db", username: "u", password: "p" },
		statePath: "unused",
		heartbeatPath: "unused",
		timezone: NY,
		tickIntervalMs: 30000,
		rescanIntervalMs: 0,
		missedGraceMs: 24 * 60 * 60 * 1000,
		ignorePaths: [],
		repeat: DEFAULT_REPEAT,
		obsidianVault: "MyVault",
		pushover: { token: "t", user: "u", device: null, priority: 0 },
		dryRun: false,
		...over,
	};
}

// A daemon wired to a capturing sender; notes are pushed straight into the
// index, so no CouchDB is involved.
function harness(notes: [id: string, path: string, content: string][], over: Partial<Config> = {}) {
	const sent: Notification[] = [];
	const daemon = new ReminderDaemon(makeConfig(over), fakeState(), async (_cfg, n) => {
		sent.push(n);
		return true;
	});
	for (const [id, notePath, content] of notes) daemon.indexNote(id, notePath, content);
	return { daemon, sent };
}

const RENT = "- [ ] pay rent @2026-03-23~rel~r=d1"; // first fires 2026-03-22 09:00 NY

test("a due reminder notifies once, and not again the same day", async () => {
	const { daemon, sent } = harness([["d1", "Bills/Rent.md", RENT]]);

	await daemon.evaluate(at(3, 22, 9, 5));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].title, "Reminder: Rent");
	assert.match(sent[0].message, /1 day before/);

	await daemon.evaluate(at(3, 22, 18));
	assert.equal(sent.length, 1);
});

test("an open task notifies again the next day, labelled as a repeat", async () => {
	const { daemon, sent } = harness([["d1", "Bills/Rent.md", RENT]]);
	await daemon.evaluate(at(3, 22, 9, 5));
	await daemon.evaluate(at(3, 23, 9, 5));
	assert.equal(sent.length, 2);
	assert.match(sent[1].message, /Task still open/);
	// The notification timestamp is the occurrence, not "now".
	assert.equal(sent[1].timestamp, Math.floor(at(3, 23, 9) / 1000));
});

test("completing the task stops the nagging", async () => {
	const { daemon, sent } = harness([["d1", "Bills/Rent.md", RENT]]);
	await daemon.evaluate(at(3, 22, 9, 5));
	daemon.indexNote("d1", "Bills/Rent.md", RENT.replace("[ ]", "[x]"));
	await daemon.evaluate(at(3, 23, 9, 5));
	assert.equal(sent.length, 1);
});

test("re-opening a completed task resumes the nagging", async () => {
	const { daemon, sent } = harness([["d1", "Bills/Rent.md", RENT]]);
	await daemon.evaluate(at(3, 22, 9, 5));
	daemon.indexNote("d1", "Bills/Rent.md", RENT.replace("[ ]", "[x]"));
	await daemon.evaluate(at(3, 23, 9, 5));
	daemon.indexNote("d1", "Bills/Rent.md", RENT);
	await daemon.evaluate(at(3, 23, 17));
	assert.equal(sent.length, 2);
});

test("reminders due in the same tick are coalesced into one digest", async () => {
	const { daemon, sent } = harness([
		["d1", "Bills/Rent.md", RENT],
		["d2", "Work/Report.md", "- [ ] send report @2026-03-23~rel~r=d1"],
		["d3", "Home/Car.md", "- [ ] book service @2026-03-23~rel~r=d1"],
	]);
	await daemon.evaluate(at(3, 22, 9, 5));

	assert.equal(sent.length, 1);
	assert.equal(sent[0].title, "3 reminders due");
	for (const name of ["Rent", "Report", "Car"]) assert.match(sent[0].message, new RegExp(name));
	// Several notes -> the digest can only open the vault.
	assert.equal(sent[0].url, "obsidian://open?vault=MyVault");
});

test("a digest from one note still deep-links to that note", async () => {
	const { daemon, sent } = harness([
		["d1", "Bills/Rent.md", `${RENT}\n- [ ] pay water @2026-03-23~rel~r=d1`],
	]);
	await daemon.evaluate(at(3, 22, 9, 5));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].url, "obsidian://open?vault=MyVault&file=Bills/Rent");
	assert.equal(sent[0].urlTitle, "Open note");
});

test("a long-overdue reminder is suppressed by the grace window", async () => {
	const { daemon, sent } = harness([["d1", "Work/Meeting.md", "meeting @2026-01-02~rel~r=d1"]]);
	await daemon.evaluate(at(3, 22, 9, 5));
	assert.equal(sent.length, 0);
});

test("notes matching ignorePaths never produce reminders", async () => {
	const { daemon, sent } = harness([["d1", "Templates/Daily.md", RENT]], {
		ignorePaths: ["Templates/**"],
	});
	await daemon.evaluate(at(3, 22, 9, 5));
	assert.equal(sent.length, 0);
	assert.deepEqual(daemon.describeAll(at(3, 22, 9, 5)), []);
});

test("repeat.maxDays bounds how long a task nags", async () => {
	const { daemon, sent } = harness([["d1", "Bills/Rent.md", RENT]], {
		repeat: { ...DEFAULT_REPEAT, maxDays: 1 },
	});
	await daemon.evaluate(at(3, 22, 9, 5)); // first firing
	await daemon.evaluate(at(3, 23, 9, 5)); // repeat 1
	await daemon.evaluate(at(3, 24, 9, 5)); // capped
	assert.equal(sent.length, 2);
});

test("--list shows the next firing, sorted, with the repeat marker", () => {
	const { daemon } = harness([
		["d1", "Bills/Rent.md", RENT],
		["d2", "Work/Sync.md", "sync @2026-04-01~rel~r=day"],
	]);
	const rows = daemon.describeAll(at(3, 20, 12));
	assert.equal(rows.length, 2);
	assert.match(rows[0], /^2026-03-22 09:00\s+\[d1,repeats\]\s+Bills\/Rent\.md:1/);
	assert.match(rows[1], /^2026-04-01 09:00\s+\[day\]\s+Work\/Sync\.md:1/);
});
