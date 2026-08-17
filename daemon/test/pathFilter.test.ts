import test from "node:test";
import assert from "node:assert/strict";
import { makePathFilter } from "../src/pathFilter";

test("no patterns ignores nothing", () => {
	const ignored = makePathFilter([]);
	assert.equal(ignored("Templates/daily.md"), false);
});

test("a folder pattern covers everything beneath it", () => {
	const ignored = makePathFilter(["Templates/**"]);
	assert.equal(ignored("Templates/daily.md"), true);
	assert.equal(ignored("Templates/nested/deep.md"), true);
	assert.equal(ignored("Notes/Templates.md"), false);
	// A note *named* like the folder is not inside it.
	assert.equal(ignored("Templatesque/x.md"), false);
});

test("a trailing slash means the folder's contents", () => {
	const ignored = makePathFilter(["Archive/"]);
	assert.equal(ignored("Archive/2024/old.md"), true);
	assert.equal(ignored("Notes/today.md"), false);
});

test("**/ matches at any depth including the root", () => {
	const ignored = makePathFilter(["**/Archive/**"]);
	assert.equal(ignored("Archive/old.md"), true);
	assert.equal(ignored("Work/2025/Archive/old.md"), true);
	assert.equal(ignored("Work/notes.md"), false);
});

test("a pattern without a slash matches the file name at any depth", () => {
	const ignored = makePathFilter(["*.excalidraw.md"]);
	assert.equal(ignored("Drawings/sketch.excalidraw.md"), true);
	assert.equal(ignored("sketch.excalidraw.md"), true);
	assert.equal(ignored("Drawings/sketch.md"), false);
});

test("* does not cross a path separator", () => {
	const ignored = makePathFilter(["Templates/*.md"]);
	assert.equal(ignored("Templates/daily.md"), true);
	assert.equal(ignored("Templates/nested/daily.md"), false);
});

test("matching is case-insensitive and literals are escaped", () => {
	const ignored = makePathFilter(["templates/**", "notes/a+b.md"]);
	assert.equal(ignored("Templates/Daily.md"), true);
	assert.equal(ignored("notes/a+b.md"), true);
	// "+" must not be read as a regex quantifier.
	assert.equal(ignored("notes/aab.md"), false);
});
