// Matches an inline date token: @YYYY-MM-DD optionally followed by " HH:mm".
// Kept in one place so the editor extension, the markdown post-processor and
// the picker all agree on exactly what a "date" looks like.
export const DATE_TOKEN_REGEX =
	/@(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/;

// Global variant for scanning a whole string / MatchDecorator.
export function dateTokenRegexGlobal(): RegExp {
	return new RegExp(DATE_TOKEN_REGEX.source, "g");
}

export interface ParsedDate {
	date: Date;
	hasTime: boolean;
}

function pad(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

// Formats a Date into the inline token text (without the leading "@").
export function formatDate(date: Date, hasTime: boolean): string {
	const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate()
	)}`;
	if (!hasTime) return base;
	return `${base} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Formats the full token including the leading "@".
export function formatToken(date: Date, hasTime: boolean): string {
	return "@" + formatDate(date, hasTime);
}

// Parses a token string (with or without the leading "@") back into a Date.
export function parseToken(token: string): ParsedDate | null {
	const m = token.match(DATE_TOKEN_REGEX);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]) - 1;
	const day = Number(m[3]);
	const hasTime = m[4] !== undefined && m[5] !== undefined;
	const hours = hasTime ? Number(m[4]) : 0;
	const minutes = hasTime ? Number(m[5]) : 0;
	const date = new Date(year, month, day, hours, minutes, 0, 0);
	if (isNaN(date.getTime())) return null;
	return { date, hasTime };
}

export function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}
