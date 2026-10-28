// The Herdr layer: run a task visibly in a Herdr tab (or a split pane) instead
// of detached. The typed line invokes the same wrapper script, whose output is
// teed to the task's log, so `bg_output` and the completion message work the
// same as detached mode. A tab closes when its task ends — the log and the
// completion message hold its output — with `keepOpen` keeping a failed one,
// renamed, on screen. Closing a tab tears down its terminal and kills the
// process tree (verified), so it is also the kill for a tab task; `taskkill`
// stays the fallback when the CLI cannot be reached.
//
// Everything is synchronous (`spawnSync`): a `herdr` call is a few dozen
// milliseconds and happens only at task start and settle, keeping the task
// lifecycle free of races. The tests swap in a fake port.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export type HerdrTask = {
	paneId: string;
	/** The tab holding the pane; absent in the split-in-current-tab mode. */
	tabId?: string;
	/** The pane's shell pid: it dies when the pane goes away. */
	shellPid: number;
	/** The pane's shell image name, which chooses the typed line's quoting. */
	shellName: string;
};

export type HerdrPort = {
	/** Whether tasks can run in Herdr panes right now. */
	available(): boolean;
	/** A new tab with one pane. */
	createTab(label: string, cwd: string): HerdrTask;
	/** A split of the calling pane, in the current tab. */
	createSplit(cwd: string): HerdrTask;
	/** Type one command line into a pane's shell. */
	runInPane(paneId: string, line: string): void;
	/** Wait until the pane's shell answers, before typing the real line; returns the shell it found. */
	ensureReady(paneId: string): { shellPid: number; shellName: string };
	/** Close a task's tab (kills its tree) or pane. */
	close(target: HerdrTask): void;
	/** Rename a pane's title; best-effort, for a failed task kept on screen. */
	rename(paneId: string, title: string): void;
};

/** Run `herdr` and parse its JSON response; `undefined` on any failure. */
function herdrJson(args: string[]): Record<string, unknown> | undefined {
	try {
		const result = spawnSync("herdr", args, { windowsHide: true, encoding: "utf8", timeout: 15000 });
		if (result.status !== 0) return undefined;
		const parsed: unknown = JSON.parse(result.stdout);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Run `herdr` and judge it by exit status alone. `herdr pane run` prints
 * nothing on success, so its empty stdout is not a failure.
 */
function herdrOk(args: string[]): boolean {
	try {
		return spawnSync("herdr", args, { windowsHide: true, encoding: "utf8", timeout: 15000 }).status === 0;
	} catch {
		return false;
	}
}

function pick(json: Record<string, unknown> | undefined, path: string[]): unknown {
	let value: unknown = json;
	for (const key of path) {
		if (typeof value !== "object" || value === null) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

/** The pane's shell pid and image name, from `herdr pane process-info`. */
function processInfo(paneId: string): { shellPid: number; shellName: string } | undefined {
	const json = herdrJson(["pane", "process-info", "--pane", paneId]);
	const shellPid = pick(json, ["result", "process_info", "shell_pid"]);
	const foreground = pick(json, ["result", "process_info", "foreground_processes"]);
	if (typeof shellPid !== "number" || shellPid <= 1) return undefined;
	let shellName = "unknown";
	if (Array.isArray(foreground)) {
		for (const entry of foreground) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const name = typeof record.name === "string" ? record.name : undefined;
			if (name === undefined) continue;
			if (record.pid === shellPid) {
				shellName = name;
				break;
			}
			if (shellName === "unknown") shellName = name;
		}
	}
	return { shellPid, shellName };
}

function makeTask(json: Record<string, unknown> | undefined, tabPath: string[] | undefined, cwd: string): HerdrTask {
	const paneId = pick(json, ["result", "root_pane", "pane_id"]);
	const tabId = tabPath === undefined ? undefined : pick(json, tabPath);
	if (typeof paneId !== "string") throw new Error("herdr did not return a pane");
	const info = processInfo(paneId);
	if (info === undefined) throw new Error("herdr did not return the pane's process");
	return {
		paneId,
		...(typeof tabId === "string" ? { tabId } : {}),
		shellPid: info.shellPid,
		shellName: info.shellName,
	};
}

/** Escape `value` for one single-quoted argument of the pane's shell. */
function quoted(value: string, shellName: string): string {
	const powershell = /pwsh|powershell/i.test(shellName);
	const escaped = powershell ? value.replace(/'/g, "''") : value.replace(/'/g, `'\\''`);
	return `'${escaped}'`;
}

/**
 * The command line typed into the pane: the shell, the wrapper script and its
 * log. Quoting follows the pane's shell family, since `herdr pane run` types
 * the line as-is (argv is space-joined, never quoted). PowerShell needs the
 * `&` call operator for a quoted path; cmd uses double quotes; POSIX shells
 * use single quotes.
 */
export function paneCommandLine(shellName: string, shell: string, scriptPath: string, logPath: string): string {
	const args = [shell, scriptPath, logPath].map((value) => quoted(value, shellName)).join(" ");
	if (/pwsh|powershell/i.test(shellName)) return `& ${args}`;
	if (/^cmd(\.exe)?$/i.test(shellName)) return [shell, scriptPath, logPath].map((value) => `"${value}"`).join(" ");
	return args;
}

let checked = false;
let available = false;

export const realHerdrPort: HerdrPort = {
	available(): boolean {
		if (!checked) {
			checked = true;
			// `herdr --version` prints a plain line, not JSON: any clean exit is enough.
			let ok = false;
			try {
				ok = process.env.HERDR_ENV === "1" && spawnSync("herdr", ["--version"], { windowsHide: true, timeout: 15000 }).status === 0;			} catch {
				ok = false;
			}
			available = ok;
		}
		return available;
	},
	createTab(label: string, cwd: string): HerdrTask {
		const json = herdrJson(["tab", "create", "--label", label, "--cwd", cwd, "--no-focus"]);
		return makeTask(json, ["result", "tab", "tab_id"], cwd);
	},
	createSplit(cwd: string): HerdrTask {
		const json = herdrJson(["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"]);
		return makeTask(json, undefined, cwd);
	},
	ensureReady(paneId: string): { shellPid: number; shellName: string } {
		// `herdr pane run` only acknowledges that the text was queued: a shell
		// that has not reached its prompt yet can drop it. Type a throwaway
		// echo and wait for its output — the prompt is up when it appears. The
		// process info is read afterwards: right after the tab exists, the
		// shell is not in the foreground list yet, and the typed line's quoting
		// depends on knowing the shell.
		const probe = `__PI_BG_READY_${randomBytes(6).toString("hex")}`;
		if (!herdrOk(["pane", "run", paneId, `echo ${probe}`])) throw new Error("herdr could not reach the pane");
		if (!herdrOk(["pane", "wait-output", paneId, "--match", probe, "--timeout", "10000"])) {
			throw new Error("the pane's shell never became ready");
		}
		return processInfo(paneId) ?? { shellPid: 0, shellName: "unknown" };
	},
	runInPane(paneId: string, line: string): void {
		if (!herdrOk(["pane", "run", paneId, line])) throw new Error("herdr could not run the command in the pane");
	},
	close(target: HerdrTask): void {
		if (!herdrOk(target.tabId !== undefined ? ["tab", "close", target.tabId] : ["pane", "close", target.paneId])) {
			throw new Error("herdr could not close the tab");
		}
	},
	rename(paneId: string, title: string): void {
		herdrOk(["pane", "report-metadata", paneId, "--source", "pi-bg-run", "--title", title]);
	},
};

let current: HerdrPort = realHerdrPort;

/** The port the extension uses: the real one unless the test harness replaced it. */
export function herdrPort(): HerdrPort {
	return current;
}

/** For the test harness only: swap the port. Nothing in the extension calls this. */
export function setHerdrPort(port: HerdrPort): void {
	current = port;
}
