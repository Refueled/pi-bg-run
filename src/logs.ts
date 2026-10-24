// The task log: where it lives, the exit-marker protocol that ends it, and the
// bounded reads behind `bg_output` and the completion tail. A task's wrapper
// appends `__BG_EXIT__:<nonce>:<code>` on its own line when the command exits;
// the nonce is random per task, so output that looks like a marker is not one.
// The crash watcher may append `__BG_GONE__:<nonce>`, and a task over the log
// limit is stopped with a `__BG_LIMIT__` line. None of the three is ever shown
// as output.
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EXIT_MARKER = "__BG_EXIT__";
export const GONE_MARKER = "__BG_GONE__";
export const LIMIT_MARKER = "__BG_LIMIT__";
/** A task writing past this is stopped: `killed (log limit passed)`. */
export const LOG_LIMIT_BYTES = 100 * 1024 * 1024;
/** Completed logs older than this are removed at session start. */
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** `$PI_BG_RUN_STATE`, by default `~/.pi-bg-run` (Windows: the user profile root). */
export function stateRoot(): string {
	const root = process.env.PI_BG_RUN_STATE;
	if (root !== undefined && root !== "") return root;
	return join(homedir(), ".pi-bg-run");
}

/** This session's log directory. */
export function sessionLogDir(sessionId: string): string {
	const dir = join(stateRoot(), sessionId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export type Marker = { code: number; start: number; end: number };

/**
 * The exit marker in `chunk`, if it holds one: the whole line, wherever it sits
 * in the chunk, matched by nonce so only this task's wrapper can end the log.
 * `start` is the line's first byte, `end` just past its newline.
 */
export function findExitMarker(chunk: string, nonce: string): Marker | undefined {
	const re = new RegExp(`(?:^|\\n)${EXIT_MARKER}:${nonce}:(-?\\d+)(?:\\r?\\n|$)`);
	const match = re.exec(chunk);
	if (match === null) return undefined;
	const start = match.index + (chunk[match.index] === "\n" ? 1 : 0);
	return { code: Number(match[1]), start, end: match.index + match[0].length };
}

/** Cut every protocol marker line out of `text`; the log keeps them, the agent never sees them. */
export function stripMarkers(text: string, nonce: string): string {
	return text.replace(
		new RegExp(`(?:^|\\n)(?:${EXIT_MARKER}:${nonce}:-?\\d+|${GONE_MARKER}:${nonce}|${LIMIT_MARKER})(?:\\r?\\n|$)`, "g"),
		"\n",
	);
}

/** Strip ANSI escapes and control characters, keeping newlines and tabs. */
export function sanitizeText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
		.replace(/\x1b[@-Z\\-_]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Drop leading continuation bytes and a trailing partial character so a buffer
 * cut anywhere never starts or ends inside a multi-byte character.
 */
export function wholeCharacters(buffer: Buffer): Buffer {
	let start = 0;
	while (start < buffer.length && start < 3 && (buffer[start] & 0xc0) === 0x80) start++;
	let end = buffer.length;
	let i = end;
	while (i > start && end - i < 3 && (buffer[i - 1] & 0xc0) === 0x80) i--;
	if (i > start && buffer[i - 1] >= 0xc0) {
		const need = buffer[i - 1] >= 0xf0 ? 4 : buffer[i - 1] >= 0xe0 ? 3 : 2;
		if (end - (i - 1) < need) end = i - 1;
	}
	return buffer.subarray(start, end);
}

/** Bytes `[start, end)` of a file, empty when it cannot be read. */
export function readRange(path: string, start: number, end: number): Buffer {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = statSync(path).size;
		const from = Math.max(0, Math.min(start, size));
		const to = Math.max(from, Math.min(end, size));
		const buffer = Buffer.alloc(to - from);
		const read = readSync(fd, buffer, 0, buffer.length, from);
		return buffer.subarray(0, read);
	} catch {
		return Buffer.alloc(0);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The file's size, 0 when it is not there. */
export function logSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export type Tail = { text: string; cut: boolean };

/** The last lines of `text`, capped in lines and bytes, and whether the cap cut anything. */
export function tailLines(text: string, maxLines = 20, maxBytes = 4096): Tail {
	const lines = text.replace(/\n$/, "").split("\n");
	const tail = lines.slice(-maxLines).join("\n");
	const bytes = Buffer.from(tail, "utf8");
	const cut = lines.length > maxLines || bytes.length > maxBytes;
	if (bytes.length <= maxBytes) return { text: tail, cut };
	return { text: wholeCharacters(bytes.subarray(bytes.length - maxBytes)).toString("utf8"), cut };
}

/** Remove this extension's logs older than `maxAgeMs`; never a running task's log. */
export function cleanupOldLogs(dir: string, maxAgeMs = LOG_MAX_AGE_MS, keep: Set<string> = new Set()): number {
	if (!existsSync(dir)) return 0;
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	for (const name of readdirSync(dir)) {
		if (keep.has(name) || !(name.endsWith(".log") || name.endsWith(".cmd.sh"))) continue;
		const path = join(dir, name);
		try {
			if (statSync(path).mtimeMs < cutoff) {
				unlinkSync(path);
				removed++;
			}
		} catch {
			// a log that cannot be stat-ed or removed is simply kept
		}
	}
	return removed;
}
