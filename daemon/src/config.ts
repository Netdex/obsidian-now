import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { CouchConfig } from "./couchSource";

export interface PushoverConfig {
	token: string;
	user: string;
	device?: string | null;
	priority?: number;
}

export interface Config {
	// Read-only connection to the Self-hosted LiveSync CouchDB.
	couch: CouchConfig;
	// Where the "already notified" state is persisted.
	statePath: string;
	// Liveness file touched every tick; used by the container healthcheck.
	heartbeatPath: string;
	// IANA zone used for dates that carry no explicit timezone. null = system.
	timezone: string | null;
	// How often to poll for changes + evaluate due reminders.
	tickIntervalMs: number;
	// A reminder overdue by more than this is marked handled without notifying
	// (avoids a burst of stale alerts on first run).
	missedGraceMs: number;
	// Optional vault name for obsidian:// deep links in notifications.
	obsidianVault?: string | null;
	pushover: PushoverConfig;
	// When true, log notifications instead of sending them.
	dryRun: boolean;
}

const DEFAULTS = {
	statePath: "./state.json",
	timezone: null as string | null,
	tickIntervalMs: 30000,
	missedGraceMs: 24 * 60 * 60 * 1000,
};

export interface LoadOptions {
	configPath?: string;
	dryRun?: boolean;
}

export function loadConfig(opts: LoadOptions = {}): Config {
	dotenv.config();

	const configPath =
		opts.configPath ?? process.env.CONFIG ?? path.resolve("config.json");
	if (!fs.existsSync(configPath)) {
		throw new Error(
			`Config file not found: ${configPath}\n` +
				`Copy config.example.json to config.json (or pass --config <path>).`
		);
	}

	const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<Config>;

	const couch: CouchConfig = {
		url: process.env.COUCHDB_URL || raw.couch?.url || "",
		database: process.env.COUCHDB_DB || raw.couch?.database || "",
		username: process.env.COUCHDB_USER || raw.couch?.username || "",
		password: process.env.COUCHDB_PASSWORD || raw.couch?.password || "",
	};
	for (const [k, v] of Object.entries(couch)) {
		if (!v) throw new Error(`couch.${k} is required (config.json or COUCHDB_* env)`);
	}

	const pushover: PushoverConfig = {
		token: process.env.PUSHOVER_TOKEN || raw.pushover?.token || "",
		user: process.env.PUSHOVER_USER || raw.pushover?.user || "",
		device: raw.pushover?.device ?? null,
		priority: raw.pushover?.priority ?? 0,
	};

	const dryRun = opts.dryRun ?? false;
	if (!dryRun && (!pushover.token || !pushover.user)) {
		throw new Error(
			"Pushover token/user missing. Set them in config.json or as " +
				"PUSHOVER_TOKEN / PUSHOVER_USER env vars (or run with --dry-run)."
		);
	}

	const statePath = path.resolve(raw.statePath ?? DEFAULTS.statePath);
	return {
		couch,
		statePath,
		heartbeatPath: (raw as any).heartbeatPath
			? path.resolve((raw as any).heartbeatPath)
			: path.join(path.dirname(statePath), "heartbeat"),
		timezone: raw.timezone ?? DEFAULTS.timezone,
		tickIntervalMs: raw.tickIntervalMs ?? DEFAULTS.tickIntervalMs,
		missedGraceMs: raw.missedGraceMs ?? DEFAULTS.missedGraceMs,
		obsidianVault: raw.obsidianVault ?? null,
		pushover,
		dryRun,
	};
}
