// Standalone liveness probe for the container healthcheck. Exits 0 if the
// daemon touched its heartbeat file recently, 1 otherwise. Intentionally has
// no dependencies beyond `fs` so it starts fast.
import * as fs from "fs";

const file = process.env.HEARTBEAT_FILE || "/state/heartbeat";
const maxAge = Number(process.env.HEALTH_MAX_AGE_MS || "120000");

try {
	const ageMs = Date.now() - fs.statSync(file).mtimeMs;
	if (ageMs <= maxAge) {
		process.exit(0);
	}
	console.error(`heartbeat stale: ${Math.round(ageMs / 1000)}s old (> ${Math.round(maxAge / 1000)}s)`);
	process.exit(1);
} catch {
	console.error(`heartbeat file missing: ${file}`);
	process.exit(1);
}
