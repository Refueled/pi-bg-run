// The log reader behind `bg_output`: pages forward from a task's read
// position, never returns a protocol marker, and moves the position only past
// what it returned. A running task's half-written last line is withheld until
// its newline arrives. `latest: true` jumps to the newest output; `filter`
// keeps only matching lines of what was read.
import { logSize, readRange, sanitizeText, stripMarkers, tailLines, wholeCharacters } from "./logs.ts";
import { stateData, stateText } from "./notify.ts";
import type { Task } from "./registry.ts";

export type OutputOptions = { latest?: boolean; filter?: string };

/** How much output one call returns at most. */
const MAX_BYTES = 8 * 1024;
/** How many lines one call returns at most. */
const MAX_LINES = 200;

export type OutputData = {
	task_id: string;
	state: string;
	exit_code?: number;
	reason?: string;
	output: string;
	truncated: boolean;
	unread_bytes: number;
};

/** The display lines of `text`, without the empty entry a trailing newline leaves. */
function toLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Keep the lines of `text` that match `filter`; reports how many were kept of how many. */
function applyFilter(text: string, filter: RegExp | undefined): { text: string; note?: string } {
	if (filter === undefined || text === "") return { text };
	const all = toLines(text);
	const kept = all.filter((line) => filter.test(line));
	return { text: kept.join("\n"), note: `[filter: ${kept.length} of ${all.length} lines matched]` };
}

/** Cap `text` to `MAX_LINES` lines: from the start when paging forward, from the end when showing the newest. */
function capLines(text: string, keep: "start" | "end"): { text: string; cut: boolean } {
	const lines = toLines(text);
	if (lines.length <= MAX_LINES) return { text, cut: false };
	const sliced = keep === "start" ? lines.slice(0, MAX_LINES) : lines.slice(lines.length - MAX_LINES);
	return { text: sliced.join("\n"), cut: true };
}

/**
 * One `bg_output` call: the text for the model and the same read as data, with
 * `task.readPosition` already advanced. `truncated` means the page left unread
 * output behind (more remains, or `latest` skipped some); `unread_bytes` counts
 * raw log bytes.
 */
export function readOutput(task: Task, options: OutputOptions): { text: string; data: OutputData } {
	let filter: RegExp | undefined;
	if (options.filter !== undefined) {
		try {
			filter = new RegExp(options.filter);
		} catch {
			throw new Error(`filter is not a valid regular expression: ${options.filter}`);
		}
	}
	const end = logSize(task.logPath);
	const from = Math.min(task.readPosition, end);
	const raw = readRange(task.logPath, from, end);
	const settled = task.state !== "running";

	// A marker only exists once the task ended, so strip and read all bytes when
	// settled; while running, withhold the part after the last newline.
	let consumed: number;
	let complete: Buffer;
	if (settled) {
		consumed = raw.length;
		complete = raw;
	} else {
		const nl = raw.lastIndexOf(0x0a);
		consumed = nl < 0 ? 0 : nl + 1;
		complete = raw.subarray(0, consumed);
	}

	let skipped = 0;
	let window = complete;
	if (options.latest) {
		skipped = Math.max(0, complete.length - MAX_BYTES);
		window = complete.subarray(skipped);
	} else if (complete.length > MAX_BYTES) {
		consumed = MAX_BYTES;
		window = complete.subarray(0, MAX_BYTES);
	}

	const body = sanitizeText(stripMarkers(wholeCharacters(window).toString("utf8"), task.nonce));
	const capped = capLines(body, options.latest ? "end" : "start");
	const filtered = applyFilter(capped.text, filter);
	const notes = [filtered.note, capped.cut ? `[capped at ${MAX_LINES} lines]` : undefined].filter(
		(note): note is string => note !== undefined,
	);

	task.readPosition = from + consumed;
	const parts = [`Task ${task.id}: ${stateText(task)}.`];
	parts.push(filtered.text === "" ? "(no new output)" : filtered.text);
	parts.push(...notes);
	return {
		text: parts.join("\n"),
		data: {
			task_id: task.id,
			...stateData(task),
			output: filtered.text,
			truncated: capped.cut || skipped > 0 || (!settled && consumed < raw.length),
			unread_bytes: end - task.readPosition,
		},
	};
}

/** The last lines of a task's log, marker removed, for the completion message. */
export function taskTail(task: Task, maxLines = 20, maxBytes = 4096): { text: string; cut: boolean } {
	const end = logSize(task.logPath);
	const start = Math.max(0, end - 64 * 1024);
	const raw = readRange(task.logPath, start, end);
	const text = sanitizeText(stripMarkers(wholeCharacters(raw).toString("utf8"), task.nonce));
	return tailLines(text, maxLines, maxBytes);
}
