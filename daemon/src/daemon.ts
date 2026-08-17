import * as fs from "fs/promises";
import * as path from "path";
import { Config } from "./config";
import { log } from "./logger";
import { CouchSource } from "./couchSource";
import {
	dueOccurrence,
	extractReminders,
	nextOccurrence,
	Occurrence,
	Reminder,
	REMINDER_LABELS,
} from "./reminders";
import { makePathFilter } from "./pathFilter";
import { State } from "./state";
import { Notification, sendPushover } from "./pushover";
import { formatPill, parseToken } from "obsidian-now-datecore";
import { DateTime } from "luxon";

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function noteTitle(filePath: string): string {
	return path.basename(filePath).replace(/\.md$/i, "");
}

// Trims a long line down to `maxChars` while keeping `keep` (the date token)
// inside the window, so the pill swap still finds it.
function trimAround(line: string, keep: string, maxChars: number): string {
	const at = line.indexOf(keep);
	if (at < 0) return line.slice(0, maxChars - 3) + "...";
	const start = Math.max(0, Math.min(at - Math.floor((maxChars - keep.length) / 2), line.length - maxChars));
	const end = Math.min(line.length, start + maxChars);
	return (start > 0 ? "..." : "") + line.slice(start, end) + (end < line.length ? "..." : "");
}

// One reminder firing at a given occurrence, ready to notify about.
interface Firing {
	r: Reminder;
	occ: Occurrence;
}

function sameNote(due: Firing[]): boolean {
	return due.every((f) => f.r.filePath === due[0].r.filePath);
}

// Pushover truncates long messages, so a digest shows this many reminders and
// then says how many were left out.
const MAX_DIGEST_ITEMS = 6;
const MAX_DIGEST_CHARS = 900;

// Injected in tests so notifications can be asserted on without a network call.
export type Sender = (
	cfg: Config["pushover"],
	n: Notification
) => Promise<boolean>;

export class ReminderDaemon {
	private source: CouchSource;
	// Keyed by CouchDB document id so the _changes feed can update/remove notes.
	private remindersById = new Map<string, Reminder[]>();
	private seq = "0";
	private tickTimer: NodeJS.Timeout | null = null;
	private evaluating = false;
	private ticksSincePrune = 0;
	private lastFullScan = 0;
	private readonly isIgnored: (notePath: string) => boolean;

	constructor(
		private readonly cfg: Config,
		private readonly state: State,
		private readonly send: Sender = sendPushover
	) {
		this.source = new CouchSource(cfg.couch);
		this.isIgnored = makePathFilter(cfg.ignorePaths);
	}

	// Full read of the vault into the in-memory index (no polling loop). Builds
	// a fresh index and swaps it in, so a periodic rescan drops notes that were
	// deleted or edited while the change feed was not being read -- and a failed
	// read leaves the previous index untouched.
	async scanAll(): Promise<void> {
		log.info("Reading vault from CouchDB (read-only)...");
		const { notes, startSeq, suspiciousBinary } = await this.source.enumerate();
		const fresh = new Map<string, Reminder[]>();
		for (const n of notes) {
			const found = this.remindersFor(n.path, n.content);
			if (found.length > 0) fresh.set(n.id, found);
		}
		this.remindersById = fresh;
		this.seq = startSeq;
		this.lastFullScan = Date.now();

		if (suspiciousBinary > 0 && notes.length === 0) {
			log.warn(
				`${suspiciousBinary} document(s) did not decode as text. This reader ` +
					`supports plaintext vaults only -- End-to-End Encryption and path ` +
					`obfuscation are not supported.`
			);
		}
		log.info(
			`Scan: ${this.countReminders()} reminder(s) across ${this.remindersById.size} note(s) with reminders.`
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

	// Refresh the index (usually from the change feed, periodically by re-reading
	// everything), then fire whatever is due.
	private async tick(): Promise<void> {
		if (this.rescanDue()) await this.rescan();
		else await this.pollChanges();
		await this.evaluate();
		await this.writeHeartbeat();
	}

	private async rescan(): Promise<void> {
		try {
			log.debug("Periodic full rescan");
			await this.scanAll();
		} catch (e) {
			// Leave the current index in place and try again at the next interval;
			// the change feed keeps working in the meantime.
			this.lastFullScan = Date.now();
			log.warn("Full rescan failed (keeping the current index):", e);
		}
	}

	private async pollChanges(): Promise<void> {
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
	}

	// A rescan is a safety net: if the change cursor ever goes stale (database
	// rebuilt, compaction, a poll error that never clears) polling would keep
	// succeeding while silently seeing nothing.
	private rescanDue(): boolean {
		if (this.cfg.rescanIntervalMs <= 0) return false;
		return Date.now() - this.lastFullScan >= this.cfg.rescanIntervalMs;
	}

	private remindersFor(notePath: string, content: string): Reminder[] {
		if (this.isIgnored(notePath)) return [];
		return extractReminders(notePath, content, this.cfg.timezone);
	}

	// Public so tests can drive the index without a CouchDB.
	indexNote(id: string, notePath: string, content: string): void {
		const found = this.remindersFor(notePath, content);
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

	async evaluate(now: number = Date.now()): Promise<void> {
		if (this.evaluating) return;
		this.evaluating = true;
		try {
			// Collect everything due first, then notify once: repeats mean a whole
			// morning's reminders routinely come due in the same tick, and one
			// digest beats a burst of separate pushes.
			const due: Firing[] = [];
			for (const list of this.remindersById.values()) {
				for (const r of list) {
					const occ = dueOccurrence(r, now, this.cfg.repeat);
					if (!occ) continue;
					// Each daily repeat of an open task de-duplicates separately.
					// Occurrence 0 keeps the bare id so state files written before
					// repeats existed still count as fired.
					const key = occ.index === 0 ? r.id : `${r.id}#${occ.index}`;
					if (this.state.has(key)) continue;
					const late = now - occ.millis;
					if (late <= this.cfg.missedGraceMs) due.push({ r, occ });
					else log.debug(`Suppressing stale reminder ${r.filePath} (${r.reminder})`);
					this.state.mark(key);
				}
			}
			if (due.length > 0) await this.fire(due, now);

			if (++this.ticksSincePrune >= 120) {
				this.ticksSincePrune = 0;
				this.state.prune(30 * 24 * 60 * 60 * 1000);
			}
		} finally {
			this.evaluating = false;
		}
	}

	private async fire(due: Firing[], now: number): Promise<void> {
		const n = this.buildNotification(due, now);
		if (this.cfg.dryRun) {
			log.info(`[dry-run] would notify: ${n.title} | ${n.message.replace(/\n/g, " / ")}`);
			return;
		}
		const summary = due
			.map(
				({ r, occ }) =>
					`${r.filePath} (${r.reminder}${occ.index > 0 ? `, repeat #${occ.index}` : ""})`
			)
			.join(", ");
		const ok = await this.send(this.cfg.pushover, n);
		if (ok) log.info(`Notified ${due.length} reminder(s): ${summary}`);
		else log.error(`Failed to notify for: ${summary}`);
	}

	// One reminder gets the detailed notification; several coming due together
	// get a digest so a morning's worth of nags is a single push.
	private buildNotification(due: Firing[], now: number): Notification {
		const n: Notification =
			due.length === 1 ? this.buildSingle(due[0], now) : this.buildDigest(due, now);
		n.html = true;
		n.timestamp = Math.floor(Math.min(...due.map((f) => f.occ.millis)) / 1000);
		const link = this.deepLink(due);
		if (link) {
			n.url = link;
			n.urlTitle = due.length === 1 || sameNote(due) ? "Open note" : "Open vault";
		}
		return n;
	}

	private buildSingle({ r, occ }: Firing, now: number): Notification {
		const context = this.contextHtml(r, occ, now, 300);
		// A repeat is no longer "1 day before" anything -- say why it is back.
		const label = occ.index > 0 ? "Task still open" : REMINDER_LABELS[r.reminder];
		return {
			title: `Reminder: ${noteTitle(r.filePath)}`,
			message:
				`<b>${escapeHtml(label)}</b> - <i>${escapeHtml(r.eventHuman)}</i>` +
				(context ? `\n${context}` : ""),
		};
	}

	private buildDigest(due: Firing[], now: number): Notification {
		const lines: string[] = [];
		let used = 0;
		let shown = 0;
		for (const f of due) {
			if (shown >= MAX_DIGEST_ITEMS || used >= MAX_DIGEST_CHARS) break;
			const context = this.contextHtml(f.r, f.occ, now, 120);
			const line = `<b>${escapeHtml(noteTitle(f.r.filePath))}</b>\n${context}`;
			used += line.length;
			lines.push(line);
			shown++;
		}
		const omitted = due.length - shown;
		if (omitted > 0) lines.push(`<i>...and ${omitted} more</i>`);
		return {
			title: `${due.length} reminders due`,
			message: lines.join("\n"),
		};
	}

	// The reminder's line with its raw @token swapped for a rendered pill --
	// the same display the plugin shows, coloured red once the date has passed.
	private contextHtml(r: Reminder, occ: Occurrence, now: number, maxChars: number): string {
		const parsed = parseToken(r.raw);
		const pillText = parsed
			? formatPill(parsed.date, parsed.hasTime, {
					format: parsed.format,
					timeFormat: parsed.timeFormat ?? "12",
					tz: parsed.tz,
			  })
			: r.raw;
		const colour = occ.millis <= now ? "#e5534b" : "#4a90d9";
		const CLOCK = "\u{23f0}";
		const pillHtml = `<b><font color="${colour}">${escapeHtml(pillText)}</font></b> ${CLOCK}`;

		// Keep the token itself intact when trimming, so the swap below still hits.
		const line =
			r.lineText.length > maxChars ? trimAround(r.lineText, r.raw, maxChars) : r.lineText;
		// The token has no HTML-special chars, so escape then swap it for the pill.
		return escapeHtml(line).replace(escapeHtml(r.raw), pillHtml);
	}

	// obsidian://open resolves the file via linkpath, so use the path without
	// the .md extension and encode each segment while keeping the slashes
	// literal (percent-encoded slashes are not resolved reliably). A digest
	// spanning several notes can only link to the vault.
	private deepLink(due: Firing[]): string | null {
		const vaultParam = this.cfg.obsidianVault
			? `vault=${encodeURIComponent(this.cfg.obsidianVault)}`
			: "";
		if (due.length > 1 && !sameNote(due)) {
			return vaultParam ? `obsidian://open?${vaultParam}` : null;
		}
		const rel = due[0].r.filePath.replace(/\.md$/i, "");
		const fileParam = rel.split("/").map(encodeURIComponent).join("/");
		return `obsidian://open?${vaultParam ? vaultParam + "&" : ""}file=${fileParam}`;
	}

	// Every reminder the daemon knows about, newest deadline first, for --list.
	describeAll(now: number = Date.now()): string[] {
		const rows: { sort: number; text: string }[] = [];
		for (const list of this.remindersById.values()) {
			for (const r of list) {
				const next = nextOccurrence(r, now, this.cfg.repeat);
				const when = next
					? DateTime.fromMillis(next.millis, r.zone ? { zone: r.zone } : {}).toFormat(
							"yyyy-LL-dd HH:mm"
					  )
					: "(no more firings)";
				const tags = [r.reminder, r.repeatDaily && this.cfg.repeat.enabled ? "repeats" : null]
					.filter(Boolean)
					.join(",");
				rows.push({
					sort: next ? next.millis : Number.MAX_SAFE_INTEGER,
					text: `${when.padEnd(18)} ${`[${tags}]`.padEnd(18)} ${r.filePath}:${r.line}  ${r.lineText}`,
				});
			}
		}
		rows.sort((a, b) => a.sort - b.sort);
		return rows.map((row) => row.text);
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
