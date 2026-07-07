import * as fs from "fs/promises";
import * as path from "path";
import { Config } from "./config";
import { log } from "./logger";
import { CouchSource } from "./couchSource";
import { extractReminders, Reminder, REMINDER_LABELS } from "./reminders";
import { State } from "./state";
import { Notification, sendPushover } from "./pushover";

export class ReminderDaemon {
	private source: CouchSource;
	// Keyed by CouchDB document id so the _changes feed can update/remove notes.
	private remindersById = new Map<string, Reminder[]>();
	private seq = "0";
	private tickTimer: NodeJS.Timeout | null = null;
	private evaluating = false;
	private ticksSincePrune = 0;

	constructor(private readonly cfg: Config, private readonly state: State) {
		this.source = new CouchSource(cfg.couch);
	}

	// Full read of the vault into the in-memory index (no polling loop).
	async scanAll(): Promise<void> {
		log.info("Reading vault from CouchDB (read-only)...");
		const { notes, startSeq, suspiciousBinary } = await this.source.enumerate();
		this.seq = startSeq;
		for (const n of notes) this.indexNote(n.id, n.path, n.content);

		if (suspiciousBinary > 0 && notes.length === 0) {
			log.warn(
				`${suspiciousBinary} document(s) did not decode as text. This reader ` +
					`supports plaintext vaults only -- End-to-End Encryption and path ` +
					`obfuscation are not supported.`
			);
		}
		log.info(
			`Initial scan: ${this.countReminders()} reminder(s) across ${this.remindersById.size} note(s) with reminders.`
		);
	}

	async start(): Promise<void> {
		await this.scanAll();
		this.tickTimer = setInterval(() => void this.tick(), this.cfg.tickIntervalMs);
		await this.tick();
	}

	async stop(): Promise<void> {
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.state.saveNow();
	}

	// Poll CouchDB for changes, update the index, then fire due reminders.
	private async tick(): Promise<void> {
		try {
			const { changedIds, lastSeq } = await this.source.poll(this.seq);
			this.seq = lastSeq;
			for (const { id, deleted } of changedIds) {
				if (deleted) {
					this.removeNote(id);
					continue;
				}
				const note = await this.source.readOne(id).catch((e) => {
					log.debug(`readOne(${id}) failed:`, e);
					return null;
				});
				if (!note) {
					// No longer a live note (e.g. type changed) -> drop it.
					this.removeNote(id);
					continue;
				}
				if (note.deleted) this.removeNote(id);
				else if (note.content !== undefined) this.indexNote(id, note.path, note.content);
			}
		} catch (e) {
			log.warn("Change poll failed (will retry next tick):", e);
		}
		await this.evaluate();
		await this.writeHeartbeat();
	}

	private indexNote(id: string, notePath: string, content: string): void {
		const found = extractReminders(notePath, content, this.cfg.timezone);
		if (found.length > 0) this.remindersById.set(id, found);
		else this.remindersById.delete(id);
	}

	private removeNote(id: string): void {
		if (this.remindersById.delete(id)) log.debug(`${id}: removed`);
	}

	private countReminders(): number {
		let n = 0;
		for (const list of this.remindersById.values()) n += list.length;
		return n;
	}

	async evaluate(): Promise<void> {
		if (this.evaluating) return;
		this.evaluating = true;
		try {
			const now = Date.now();
			for (const list of this.remindersById.values()) {
				for (const r of list) {
					if (this.state.has(r.id)) continue;
					if (r.fireMillis > now) continue;
					const late = now - r.fireMillis;
					if (late <= this.cfg.missedGraceMs) await this.fire(r);
					else log.debug(`Suppressing stale reminder ${r.filePath} (${r.reminder})`);
					this.state.mark(r.id);
				}
			}
			if (++this.ticksSincePrune >= 120) {
				this.ticksSincePrune = 0;
				this.state.prune(30 * 24 * 60 * 60 * 1000);
			}
		} finally {
			this.evaluating = false;
		}
	}

	private async fire(r: Reminder): Promise<void> {
		const n = this.buildNotification(r);
		if (this.cfg.dryRun) {
			log.info(`[dry-run] would notify: ${n.title} | ${n.message.replace(/\n/g, " / ")}`);
			return;
		}
		const ok = await sendPushover(this.cfg.pushover, n);
		if (ok) log.info(`Notified: ${r.filePath} (${r.reminder}) -> ${r.eventHuman}`);
		else log.error(`Failed to notify for ${r.filePath} (${r.reminder})`);
	}

	private buildNotification(r: Reminder): Notification {
		const noteTitle = path.basename(r.filePath).replace(/\.md$/i, "");
		const context = r.lineText.length > 200 ? r.lineText.slice(0, 197) + "..." : r.lineText;
		const message = `${REMINDER_LABELS[r.reminder]} - ${r.eventHuman}` + (context ? `\n${context}` : "");
		const n: Notification = {
			title: `Reminder: ${noteTitle}`,
			message,
			timestamp: Math.floor(r.fireMillis / 1000),
		};
		if (this.cfg.obsidianVault) {
			const file = r.filePath.replace(/\.md$/i, "");
			n.url = `obsidian://open?vault=${encodeURIComponent(this.cfg.obsidianVault)}&file=${encodeURIComponent(file)}`;
			n.urlTitle = "Open note";
		}
		return n;
	}

	private async writeHeartbeat(): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.cfg.heartbeatPath), { recursive: true });
			await fs.writeFile(this.cfg.heartbeatPath, String(Date.now()), "utf8");
		} catch (e) {
			log.debug("Could not write heartbeat:", e);
		}
	}
}
