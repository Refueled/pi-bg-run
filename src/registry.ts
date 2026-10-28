// The task registry, kept on `globalThis` because Pi loads extensions with a
// cold module cache: module state does not survive `/reload`, this does. It
// holds the poller that settles tasks from their log's exit marker, enforces
// timeouts and the log limit, and sends each task's completion message once.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findExitMarker, cleanupOldLogs, logSize, LOG_LIMIT_BYTES, readRange, sessionLogDir } from "./logs.ts";
import { resolveShell, spawnWatcher, writeWrapper } from "./launch.ts";
import { herdrPort, paneCommandLine, type HerdrTask } from "./herdr.ts";
import { sendCompletion, stateText, type PiLike } from "./notify.ts";
import { processPort } from "./process.ts";

const KEY = Symbol.for("pi-bg-run.registry");
/** How often the poller looks at running tasks. */
export const POLL_MS = 1000;
/** How long after a task's pid dies the marker is still waited for. */
export const DEAD_GRACE_MS = 3000;
/** Bytes kept for marker straddling a read boundary. */
const SCAN_OVERLAP = 256;

/** `killed` carries a `reason`; the rest end by themselves. */
export type TaskState = "running" | "exited" | "exit-unknown" | "killed";

/** Why the registry killed a task. */
export type KillReason = "killed by agent" | "killed by user" | "timed out" | "log limit passed";

export type Task = {
	id: string;
	command: string;
	label?: string;
	cwd: string;
	logPath: string;
	scriptPath: string;
	pid: number;
	/** Random per task; only the wrapper knows it, so only its marker line counts. */
	nonce: string;
	/** Where the next marker search starts in the log. */
	scanFrom: number;
	startedAt: number;
	endedAt?: number;
	state: TaskState;
	exitCode?: number;
	/** Set when `state` is `killed`. */
	reason?: KillReason;
	/** When the poller kills the task: `startedAt` plus the call's `timeoutSeconds`. */
	deadline?: number;
	/** When the poller last saw the task's pid alive, while it is dying. */
	deadSince?: number;
	/** Where `bg_output` will next read; the completion tail never moves it. */
	readPosition: number;
	notified: boolean;
	/** Set when the task runs in a Herdr tab or split instead of detached. */
	herdr?: HerdrTask;
	/** Keep the Herdr tab or pane open, renamed, when the task ends unsuccessfully. */
	keepOpen?: boolean;
};

type Registry = {
	tasks: Map<string, Task>;
	nextId: number;
	pi?: PiLike;
	sessionId?: string;
	cwd?: string;
	poller?: ReturnType<typeof setInterval>;
	/** Whether old logs were cleaned this session. */
	cleaned: boolean;
};

/** The one registry of this Pi process. */
export function getRegistry(): Registry {
	const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
	const registry = (holder[KEY] ??= { tasks: new Map(), nextId: 1, cleaned: false });
	registry.cleaned ??= false;
	return registry;
}

/**
 * Refresh the session this runtime works for (each `/reload` calls it again).
 * A different session is a different conversation: its tasks are not this
 * one's to list or manage, so they are killed and forgotten and the ids start
 * over at `bg-1`. The same session keeps its tasks. Starts the poller once and
 * removes logs a past session left behind.
 */
export function attach(pi: PiLike, sessionId: string, cwd: string): void {
	const registry = getRegistry();
	if (registry.sessionId !== undefined && registry.sessionId !== sessionId) {
		for (const task of registry.tasks.values()) killTask(task, "killed by user", false);
		registry.tasks.clear();
		registry.nextId = 1;
	}
	registry.pi = pi;
	registry.sessionId = sessionId;
	registry.cwd = cwd;
	if (registry.poller === undefined) {
		registry.poller = setInterval(pollOnce, POLL_MS);
		registry.poller.unref?.();
	}
	if (!registry.cleaned) {
		registry.cleaned = true;
		try {
			const keep = new Set([...registry.tasks.values()].map((task) => task.id + ".log"));
			cleanupOldLogs(sessionLogDir(sessionId), undefined, keep);
		} catch {
			// cleanup is best-effort
		}
	}
}

export type StartOptions = {
	command: string;
	cwd?: string;
	timeoutSeconds?: number;
	label?: string;
	/** Keep the task's Herdr tab or pane open, renamed, when it ends unsuccessfully. */
	keepOpen?: boolean;
	/** The shell Pi's own bash uses, when it reports one. */
	shell?: string;
	/** Run in a Herdr tab or split; `none` detached. Defaults to `tab` inside Herdr. */
	herdr?: "tab" | "pane" | "none";
};

/** Start a task: write its wrapper, launch it detached, watch for Pi's death. */
export async function startTask(options: StartOptions): Promise<Task> {
	const registry = getRegistry();
	const command = options.command;
	if (command.trim() === "") throw new Error("command must not be empty");
	const cwd = options.cwd ?? registry.cwd ?? process.cwd();
	if (!existsSync(cwd)) throw new Error("Working directory does not exist");
	const sessionId = registry.sessionId ?? "no-session";
	const dir = sessionLogDir(sessionId);

	// Ids start at bg-1 in each session: skip any id whose log is already there
	// from an earlier run of the same session, so its output is never overwritten.
	let id = "";
	let logPath = "";
	do {
		id = `bg-${registry.nextId++}`;
		logPath = join(dir, `${id}.log`);
	} while (existsSync(logPath));
	const nonce = randomBytes(8).toString("hex");
	const scriptPath = join(dir, `${id}.cmd.sh`);
	writeFileSync(logPath, "", { flag: "wx" });

	const task: Task = {
		id,
		command,
		...(options.label === undefined ? {} : { label: options.label }),
		...(options.keepOpen === undefined ? {} : { keepOpen: options.keepOpen }),
		cwd,
		logPath,
		scriptPath,
		pid: 0,
		nonce,
		scanFrom: 0,
		startedAt: Date.now(),
		state: "running",
		readPosition: 0,
		notified: false,
	};
	if (options.timeoutSeconds !== undefined && options.timeoutSeconds > 0) {
		task.deadline = task.startedAt + options.timeoutSeconds * 1000;
	}

	// Herdr mode: the task runs visibly in a new tab (or a split), its output
	// teed to the same log. Any failure here falls back to the detached task.
	const mode = options.herdr ?? (herdrPort().available() ? "tab" : "none");
	if (mode !== "none" && herdrPort().available()) {
		let target: HerdrTask | undefined;
		try {
			writeWrapper(scriptPath, command, nonce, "pane");
			target = mode === "tab" ? herdrPort().createTab(options.label ?? id, cwd) : herdrPort().createSplit(cwd);
			// The shell is only reliably known once it answers the readiness probe:
			// right after the tab exists, the foreground list can still be empty.
			const described = herdrPort().ensureReady(target.paneId);
			if (described.shellPid > 1) target.shellPid = described.shellPid;
			if (described.shellName !== "unknown") target.shellName = described.shellName;
			herdrPort().runInPane(
				target.paneId,
				paneCommandLine(target.shellName, resolveShell(options.shell), scriptPath, logPath),
			);
			task.herdr = target;
			task.pid = target.shellPid;
			registry.tasks.set(id, task);
			return task;
		} catch {
			// Herdr did not take the task; close the tab opened for it and run
			// detached instead.
			if (target !== undefined) {
				try {
					herdrPort().close(target);
				} catch {
					// the orphan tab stays visible; nothing runs in it
				}
			}
		}
	}

	writeWrapper(scriptPath, command, nonce);
	const env: NodeJS.ProcessEnv = { ...process.env, PI_SESSION_ID: sessionId };
	task.pid = await processPort().launch({ shell: resolveShell(options.shell), scriptPath, cwd, env, logPath });
	if (process.env.PI_BG_RUN_NO_WATCHER === undefined) spawnWatcher(process.pid, task.pid, nonce, logPath);
	registry.tasks.set(id, task);
	return task;
}

/** Stop a task and settle it with `reason`; `notify` false at session end. */
export function killTask(task: Task, reason: KillReason, notify = true): void {
	if (task.state !== "running") return;
	try {
		// Closing a Herdr tab tears down its terminal and the process tree with
		// it (verified), so it is the kill for a tab task. When the CLI cannot
		// close the tab, kill the tree directly instead.
		if (task.herdr !== undefined) herdrPort().close(task.herdr);
		else processPort().killTree(task.pid);
	} catch {
		try {
			processPort().killTree(task.pid);
		} catch {
			// the task is settled either way
		}
	}
	task.state = "killed";
	task.reason = reason;
	task.endedAt = Date.now();
	maybeNotify(task, notify);
}

function settle(task: Task, state: TaskState, exitCode?: number): void {
	task.state = state;
	if (exitCode !== undefined) task.exitCode = exitCode;
	task.endedAt = Date.now();
	if (task.herdr !== undefined) {
		// The tab has shown all it can once the task ends: the log and the
		// completion message hold its output, so the tab closes on any outcome
		// and nothing is left open to clean up. `keepOpen` is the one exception:
		// a failed tab stays, renamed, when the caller wants it on screen.
		const succeeded = state === "exited" && exitCode === 0;
		try {
			if (task.keepOpen === true && !succeeded) herdrPort().rename(task.herdr.paneId, `${task.id} failed: ${stateText(task)}`);
			else herdrPort().close(task.herdr);
		} catch {
			// presentation only; the task is settled either way
		}
	}
}

function maybeNotify(task: Task, notify = true): void {
	const registry = getRegistry();
	if (!notify || task.notified || registry.pi === undefined) return;
	task.notified = true;
	try {
		sendCompletion(registry.pi, task);
	} catch {
		// a failed message must not stop the poller
	}
}

/** Find this task's exit marker in the log's unread part, advancing `scanFrom`. */
function scanForMarker(task: Task): { code: number } | undefined {
	const end = logSize(task.logPath);
	if (end <= task.scanFrom) return undefined;
	const chunk = readRange(task.logPath, task.scanFrom, end).toString("utf8");
	const marker = findExitMarker(chunk, task.nonce);
	if (marker !== undefined) return { code: marker.code };
	// Keep an overlap so a marker straddling two polls is still found.
	task.scanFrom = Math.max(task.scanFrom, end - SCAN_OVERLAP);
	return undefined;
}

/** One poller pass: settle finished tasks, enforce timeouts and the log limit. Exported for tests. */
export function pollOnce(): void {
	const registry = getRegistry();
	for (const task of registry.tasks.values()) {
		if (task.state !== "running") continue;
		const marker = scanForMarker(task);
		if (marker !== undefined) {
			settle(task, "exited", marker.code);
			maybeNotify(task);
			continue;
		}
		if (task.deadline !== undefined && Date.now() >= task.deadline) {
			killTask(task, "timed out");
			continue;
		}
		try {
			if (statSync(task.logPath).size > LOG_LIMIT_BYTES) {
				try {
					appendFileSync(task.logPath, `\n__BG_LIMIT__\n`);
				} catch {
					// the kill below is what matters
				}
				killTask(task, "log limit passed");
				continue;
			}
		} catch {
			// an unstatable log is not a reason to kill anything
		}
		if (!processPort().pidAlive(task.pid)) {
			task.deadSince ??= Date.now();
			// The marker can arrive after the pid dies (buffered writes); give it
			// a grace period before calling the exit unknown.
			if (Date.now() - task.deadSince >= DEAD_GRACE_MS) {
				settle(task, "exit-unknown");
				maybeNotify(task);
			}
		} else {
			task.deadSince = undefined;
		}
	}
}

/** The session is over (quit, new, resume, fork): kill every running task silently. */
export function endSession(): void {
	const registry = getRegistry();
	for (const task of registry.tasks.values()) killTask(task, "killed by user", false);
	if (registry.poller !== undefined) {
		clearInterval(registry.poller);
		registry.poller = undefined;
	}
}
