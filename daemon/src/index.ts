import { loadConfig } from "./config";
import { log, setVerbose } from "./logger";
import { State } from "./state";
import { ReminderDaemon } from "./daemon";

interface Args {
	configPath?: string;
	dryRun: boolean;
	verbose: boolean;
	once: boolean;
}

function parseArgs(argv: string[]): Args {
	const a: Args = { dryRun: false, verbose: false, once: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--config" || arg === "-c") a.configPath = argv[++i];
		else if (arg === "--dry-run") a.dryRun = true;
		else if (arg === "--verbose" || arg === "-v") a.verbose = true;
		else if (arg === "--once") a.once = true;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else log.warn(`Unknown argument: ${arg}`);
	}
	return a;
}

function printHelp(): void {
	console.log(
		`obsidian-remind - Pushover reminders for Obsidian @date tokens\n\n` +
			`Reads a Self-hosted LiveSync CouchDB vault read-only and notifies via Pushover.\n\n` +
			`Usage: obsidian-remind [options]\n\n` +
			`Options:\n` +
			`  -c, --config <path>  Config file (default: ./config.json or $CONFIG)\n` +
			`      --dry-run        Log notifications instead of sending them\n` +
			`      --once           Scan once, fire due reminders, then exit\n` +
			`  -v, --verbose        Verbose logging\n` +
			`  -h, --help           Show this help\n`
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	setVerbose(args.verbose);

	const cfg = loadConfig({ configPath: args.configPath, dryRun: args.dryRun });
	log.info(
		`obsidian-remind starting (couch: ${cfg.couch.url}/${cfg.couch.database}, dryRun: ${cfg.dryRun})`
	);

	const state = new State(cfg.statePath);
	state.load();
	state.prune(30 * 24 * 60 * 60 * 1000);

	const daemon = new ReminderDaemon(cfg, state);

	if (args.once) {
		await daemon.scanAll();
		await daemon.evaluate();
		await daemon.stop();
		state.saveNow();
		log.info("Single run complete.");
		process.exit(0);
	}

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`Received ${signal}, shutting down...`);
		await daemon.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	await daemon.start();
	log.info("Running. Press Ctrl+C to stop.");
}

main().catch((e) => {
	log.error("Fatal:", e instanceof Error ? e.message : e);
	process.exit(1);
});
