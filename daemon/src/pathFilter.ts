// Glob matching for vault-relative note paths, used by config.ignorePaths to
// keep template/archive folders from producing live reminders. Deliberately
// tiny (no dependency) and limited to the shapes that are actually useful:
//
//   Templates/**        everything under a top-level folder ("Templates/" too)
//   **/Archive/**       an "Archive" folder anywhere, including at the root
//   *.excalidraw.md     a name pattern, matched anywhere in the vault
//
// "*" matches within one path segment, "**" across segments, "?" one character.
// Matching is case-insensitive, since vaults move between case-sensitive and
// case-insensitive filesystems.

function escapeLiteral(ch: string): string {
	return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
	// A trailing slash means "this folder's contents".
	const p = pattern.endsWith("/") ? pattern + "**" : pattern;
	let out = "";
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === "*") {
			if (p[i + 1] === "*") {
				// "**/" matches zero or more leading segments, so "**/Archive/**"
				// also matches an "Archive" folder sitting at the vault root.
				if (p[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else out += "[^/]*";
		} else if (c === "?") out += "[^/]";
		else out += escapeLiteral(c);
	}
	return new RegExp(`^${out}$`, "i");
}

// Builds a predicate answering "should this note be ignored?". A pattern with
// no "/" is also tried against the file name alone, so "*.excalidraw.md"
// matches at any depth without needing a "**/" prefix.
export function makePathFilter(patterns: string[]): (notePath: string) => boolean {
	const matchers = patterns
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => ({ re: globToRegExp(p), nameOnly: !p.includes("/") }));
	if (matchers.length === 0) return () => false;
	return (notePath: string) => {
		const name = notePath.slice(notePath.lastIndexOf("/") + 1);
		return matchers.some((m) => m.re.test(notePath) || (m.nameOnly && m.re.test(name)));
	};
}
