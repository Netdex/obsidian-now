type Level = "debug" | "info" | "warn" | "error";

let verbose = false;

export function setVerbose(v: boolean): void {
	verbose = v;
}

function ts(): string {
	return new Date().toISOString();
}

function emit(level: Level, args: unknown[]): void {
	if (level === "debug" && !verbose) return;
	const line = `${ts()} [${level.toUpperCase()}]`;
	if (level === "error") console.error(line, ...args);
	else if (level === "warn") console.warn(line, ...args);
	else console.log(line, ...args);
}

export const log = {
	debug: (...a: unknown[]) => emit("debug", a),
	info: (...a: unknown[]) => emit("info", a),
	warn: (...a: unknown[]) => emit("warn", a),
	error: (...a: unknown[]) => emit("error", a),
};
