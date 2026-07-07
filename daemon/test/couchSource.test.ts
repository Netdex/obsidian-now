import test from "node:test";
import assert from "node:assert/strict";
import { reassembleContent, isNoteCandidateId, isLiveNote, NoteDoc } from "../src/couchSource";

test("reassembles a plain note from leaf chunks in child order", () => {
	const doc: NoteDoc = {
		_id: "n.md",
		type: "plain",
		path: "n.md",
		children: ["c1", "c2"],
	};
	const chunks = new Map([
		["c1", "# Title\n"],
		["c2", "body @2026-03-23~r=d1\n"],
	]);
	assert.equal(reassembleContent(doc, chunks), "# Title\nbody @2026-03-23~r=d1\n");
});

test("prefers inline eden chunks over leaf docs", () => {
	const doc: NoteDoc = {
		_id: "n.md",
		type: "plain",
		path: "n.md",
		children: ["c1"],
		eden: { c1: { data: "from-eden", epoch: 1 } },
	};
	assert.equal(reassembleContent(doc, new Map()), "from-eden");
});

test("legacy 'notes' type uses inline data (string or array)", () => {
	assert.equal(
		reassembleContent({ _id: "a", type: "notes", path: "a", data: ["x", "y"] }, new Map()),
		"xy"
	);
	assert.equal(
		reassembleContent({ _id: "a", type: "notes", path: "a", data: "hello" }, new Map()),
		"hello"
	);
});

test("returns null when a referenced chunk is missing", () => {
	const doc: NoteDoc = { _id: "n", type: "plain", path: "n", children: ["c1", "c2"] };
	assert.equal(reassembleContent(doc, new Map([["c1", "only"]])), null);
});

test("returns null for non-text (encrypted/binary-looking) content", () => {
	const doc: NoteDoc = { _id: "n", type: "plain", path: "n", children: ["c1"] };
	// Mostly NUL bytes -> not plain text (built at runtime to keep source ASCII).
	const binary = String.fromCharCode(0).repeat(50) + "abc";
	assert.equal(reassembleContent(doc, new Map([["c1", binary]])), null);
});

test("chunk/meta ids are not treated as note candidates", () => {
	assert.equal(isNoteCandidateId("h:abcdef"), false);
	assert.equal(isNoteCandidateId("ix:xyz"), false);
	assert.equal(isNoteCandidateId("_design/x"), false);
	assert.equal(isNoteCandidateId("Projects/Immigration.md"), true);
});

test("isLiveNote filters deleted and non-note docs", () => {
	assert.equal(isLiveNote({ _id: "a", type: "plain", path: "a.md" }), true);
	assert.equal(isLiveNote({ _id: "a", type: "plain", path: "a.md", deleted: true }), false);
	assert.equal(isLiveNote({ _id: "a", type: "leaf", path: "a.md" }), false);
	assert.equal(isLiveNote({ _id: "a", type: "plain" }), false);
});
