import { log } from "./logger";

export interface CouchConfig {
	url: string; // e.g. https://couch.example.org (no trailing slash needed)
	database: string;
	username: string;
	password: string;
}

// LiveSync entry types (see livesync-commonlib db.const.ts).
const NOTE_TYPES = new Set(["plain", "newnote", "notes"]);
// Document id prefixes used by chunks / packs / info entries -- never notes.
const NON_NOTE_ID_PREFIXES = ["h:", "i:", "ix:", "ps:", "_"];

export interface NoteDoc {
	_id: string;
	_rev?: string;
	_deleted?: boolean;
	type?: string;
	path?: string;
	deleted?: boolean;
	children?: string[];
	data?: string | string[];
	eden?: Record<string, { data: string; epoch: number }>;
}

interface LeafDoc {
	_id: string;
	type?: string;
	data?: string;
}

export function isNoteCandidateId(id: string): boolean {
	return !NON_NOTE_ID_PREFIXES.some((p) => id.startsWith(p));
}

export function isLiveNote(doc: NoteDoc): boolean {
	return (
		!!doc.type &&
		NOTE_TYPES.has(doc.type) &&
		!doc.deleted &&
		!doc._deleted &&
		typeof doc.path === "string" &&
		doc.path.length > 0
	);
}

// Reassembles a note's text content from its chunks. Pure and unit-testable:
// `chunkData` maps chunk id -> chunk text (from leaf docs). Inline `eden`
// chunks on the note take precedence. Returns null for content that is not
// plain text (binary/newnote or, most likely, an encrypted vault).
export function reassembleContent(
	doc: NoteDoc,
	chunkData: Map<string, string>
): string | null {
	let raw: string;
	if (doc.type === "notes") {
		// Legacy inline note.
		raw = Array.isArray(doc.data) ? doc.data.join("") : doc.data ?? "";
	} else {
		const parts: string[] = [];
		for (const id of doc.children ?? []) {
			const eden = doc.eden?.[id]?.data;
			const piece = eden !== undefined ? eden : chunkData.get(id);
			if (piece === undefined) return null; // missing chunk
			parts.push(piece);
		}
		raw = parts.join("");
		if (doc.type === "newnote") {
			// Binary file stored as base64; only decode if it is actually text.
			try {
				raw = Buffer.from(raw, "base64").toString("utf8");
			} catch {
				return null;
			}
		}
	}
	return looksLikeText(raw) ? raw : null;
}

// Heuristic to catch encrypted/binary payloads: too many control characters or
// a U+FFFD replacement means it is not the plaintext we can scan.
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

function looksLikeText(s: string): boolean {
	if (s.length === 0) return true;
	if (s.includes(REPLACEMENT_CHAR)) return false;
	let control = 0;
	const sample = s.length > 2000 ? s.slice(0, 2000) : s;
	for (let i = 0; i < sample.length; i++) {
		const c = sample.charCodeAt(i);
		if (c < 9 || (c > 13 && c < 32)) control++;
	}
	return control / sample.length < 0.02;
}

export interface NoteContent {
	id: string;
	path: string;
	content: string;
}

export interface EnumerateResult {
	notes: NoteContent[];
	startSeq: string; // change-feed cursor to poll from
	suspiciousBinary: number; // notes that failed the text check
}

export class CouchSource {
	private readonly base: string;
	private readonly authHeader: string;

	constructor(private readonly cfg: CouchConfig) {
		this.base = `${cfg.url.replace(/\/$/, "")}/${encodeURIComponent(cfg.database)}`;
		this.authHeader =
			"Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
	}

	private async req(path: string, init?: RequestInit): Promise<any> {
		const res = await fetch(this.base + path, {
			...init,
			headers: {
				Authorization: this.authHeader,
				"Content-Type": "application/json",
				...(init?.headers ?? {}),
			},
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`CouchDB ${init?.method ?? "GET"} ${path} -> ${res.status} ${body.slice(0, 200)}`);
		}
		return res.json();
	}

	// Verifies connectivity and returns the current update_seq.
	private async dbInfo(): Promise<{ update_seq: string }> {
		return this.req("");
	}

	private async bulkGet(ids: string[]): Promise<Map<string, NoteDoc & LeafDoc>> {
		const out = new Map<string, NoteDoc & LeafDoc>();
		const BATCH = 500;
		for (let i = 0; i < ids.length; i += BATCH) {
			const slice = ids.slice(i, i + BATCH);
			const body = JSON.stringify({ docs: slice.map((id) => ({ id })) });
			const json = await this.req("/_bulk_get", { method: "POST", body });
			for (const result of json.results ?? []) {
				const ok = result.docs?.find((d: any) => d.ok)?.ok;
				if (ok) out.set(ok._id, ok);
			}
		}
		return out;
	}

	// Full read of all current notes plus the seq to start polling from.
	async enumerate(): Promise<EnumerateResult> {
		const info = await this.dbInfo();
		const startSeq = String(info.update_seq);

		const all = await this.req("/_all_docs");
		const candidateIds = (all.rows ?? [])
			.map((r: any) => r.id as string)
			.filter((id: string) => isNoteCandidateId(id));

		const docs = await this.bulkGet(candidateIds);
		const noteDocs: NoteDoc[] = [];
		for (const doc of docs.values()) {
			if (isLiveNote(doc)) noteDocs.push(doc);
		}
		log.info(`Found ${noteDocs.length} note(s) in CouchDB`);

		const contents = await this.readNotes(noteDocs);
		return { notes: contents.notes, suspiciousBinary: contents.suspiciousBinary, startSeq };
	}

	// Fetches all chunks referenced by the given notes and reassembles them.
	private async readNotes(
		noteDocs: NoteDoc[]
	): Promise<{ notes: NoteContent[]; suspiciousBinary: number }> {
		const chunkIds = new Set<string>();
		for (const doc of noteDocs) {
			for (const id of doc.children ?? []) {
				if (!doc.eden?.[id]) chunkIds.add(id);
			}
		}
		const chunkDocs = await this.bulkGet([...chunkIds]);
		const chunkData = new Map<string, string>();
		for (const [id, d] of chunkDocs) {
			if (typeof d.data === "string") chunkData.set(id, d.data);
		}

		const notes: NoteContent[] = [];
		let suspiciousBinary = 0;
		for (const doc of noteDocs) {
			const content = reassembleContent(doc, chunkData);
			if (content === null) suspiciousBinary++;
			else notes.push({ id: doc._id, path: doc.path as string, content });
		}
		return { notes, suspiciousBinary };
	}

	// Reads a single note by document id (used after a change).
	async readOne(
		id: string
	): Promise<{ id: string; path: string; content?: string; deleted?: boolean } | null> {
		const docs = await this.bulkGet([id]);
		const doc = docs.get(id);
		if (!doc) return null;
		if (doc.deleted || doc._deleted) {
			return { id, path: doc.path ?? "", deleted: true };
		}
		if (!isLiveNote(doc)) return null;
		const { notes } = await this.readNotes([doc]);
		if (notes.length === 0) return null;
		return { id, path: notes[0].path, content: notes[0].content };
	}

	// Polls the changes feed since `seq`. Returns changed note ids and the new
	// cursor. Read-only (GET _changes).
	async poll(
		seq: string
	): Promise<{ changedIds: { id: string; deleted: boolean }[]; lastSeq: string }> {
		const json = await this.req(`/_changes?since=${encodeURIComponent(seq)}`);
		const changedIds: { id: string; deleted: boolean }[] = [];
		for (const row of json.results ?? []) {
			if (typeof row.id === "string" && isNoteCandidateId(row.id)) {
				changedIds.push({ id: row.id, deleted: !!row.deleted });
			}
		}
		return { changedIds, lastSeq: String(json.last_seq ?? seq) };
	}
}
