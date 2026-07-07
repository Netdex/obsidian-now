import * as fs from "fs";
import * as path from "path";
import { log } from "./logger";

interface StateFile {
	// reminder id -> epoch ms when it was handled (sent or intentionally skipped).
	fired: Record<string, number>;
}

// Tracks which reminders have already been handled so restarts and rescans
// never double-notify. Entries are pruned once they age out.
export class State {
	private data: StateFile = { fired: {} };
	private saveTimer: NodeJS.Timeout | null = null;

	constructor(private readonly filePath: string) {}

	load(): void {
		try {
			if (fs.existsSync(this.filePath)) {
				const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
				if (parsed && typeof parsed === "object" && parsed.fired) {
					this.data = { fired: parsed.fired };
				}
			}
		} catch (e) {
			log.warn(`Could not read state (${this.filePath}); starting fresh:`, e);
			this.data = { fired: {} };
		}
	}

	has(id: string): boolean {
		return id in this.data.fired;
	}

	mark(id: string): void {
		this.data.fired[id] = Date.now();
		this.scheduleSave();
	}

	// Drop handled entries older than `maxAgeMs` to keep the file bounded.
	prune(maxAgeMs: number): void {
		const cutoff = Date.now() - maxAgeMs;
		let removed = 0;
		for (const [id, when] of Object.entries(this.data.fired)) {
			if (when < cutoff) {
				delete this.data.fired[id];
				removed++;
			}
		}
		if (removed > 0) {
			log.debug(`Pruned ${removed} old state entries`);
			this.scheduleSave();
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, 500);
	}

	saveNow(): void {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			fs.writeFileSync(this.filePath, JSON.stringify(this.data), "utf8");
		} catch (e) {
			log.error(`Failed to persist state (${this.filePath}):`, e);
		}
	}
}
