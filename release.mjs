// One-command release helper.
//
//   node release.mjs            -> release the version currently in manifest.json
//   node release.mjs 1.2.0      -> bump manifest.json + versions.json to 1.2.0, then release
//
// It builds, syncs versions.json, commits any version bump, pushes, and creates
// a GitHub release with the three assets BRAT needs (main.js, manifest.json,
// styles.css). Requires `gh` to be authenticated.
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const SEMVER = /^\d+\.\d+\.\d+$/;

function run(cmd, opts = {}) {
	console.log(`$ ${cmd}`);
	return execSync(cmd, { stdio: "inherit", ...opts });
}

function capture(cmd) {
	return execSync(cmd, { encoding: "utf8" }).trim();
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const argVersion = process.argv[2];

if (argVersion) {
	if (!SEMVER.test(argVersion)) {
		console.error(`Invalid version "${argVersion}" (expected x.y.z).`);
		process.exit(1);
	}
	// Bump manifest.json.
	manifest.version = argVersion;
	writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

	// Keep versions.json in sync (version -> minAppVersion).
	const versions = JSON.parse(readFileSync("versions.json", "utf8"));
	versions[argVersion] = manifest.minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
	console.log(`Bumped manifest.json + versions.json to ${argVersion}.`);
}

const version = manifest.version;
if (!SEMVER.test(version)) {
	console.error(`manifest.json version "${version}" is not x.y.z.`);
	process.exit(1);
}

// Refuse to release over an existing tag (check the remote so a stale local
// clone can't accidentally clobber a published release).
const remoteTags = capture("git ls-remote --tags origin");
if (remoteTags.split(/\r?\n/).some((l) => l.endsWith(`refs/tags/${version}`))) {
	console.error(`Tag ${version} already exists on origin. Bump the version first.`);
	process.exit(1);
}

// Build.
run("npm run build");

// Commit any pending changes (version bump, etc.). No-op if nothing changed.
const dirty = capture("git status --porcelain");
if (dirty) {
	run("git add -A");
	run(`git commit -m "Release ${version}"`);
}

// Push the branch.
const branch = capture("git rev-parse --abbrev-ref HEAD");
run(`git push origin ${branch}`);

// Create the GitHub release with the BRAT assets.
run(
	`gh release create ${version} main.js manifest.json styles.css ` +
		`--title "${version}" --notes "Release ${version}"`
);

console.log(`\nReleased ${version}. BRAT users will get it on next update.`);
