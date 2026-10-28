// Cache-warming mode: while a task runs, keep the provider's prompt cache warm
// so the completion turn does not pay a cache miss after a long idle wait.
// Pi's own cache warmer re-sends the last request with a one-token output cap
// at 90% of the cache lifetime — invisible: the refresh never enters model
// context and does not wake the agent. Its economics assume a 15% chance that
// a request arrives while idle, so it usually declines exactly when an agent
// waits on a background task; `warmDecision` overrides the decision to "warm"
// while any task runs. The heartbeat is the user-facing half: a footer status
// line refreshed every `PI_BG_RUN_HEARTBEAT_S` seconds (default 100).
//
// There are deliberately no model-facing heartbeat messages: each would be a
// full turn (prefix re-read at cache-read price plus two messages appended to
// the transcript per beat) to do what one silent replay already does.
//
// Prerequisites pi cannot infer: the global setting `"cacheWarming": "idle"`
// (the default `"streaming"` stops warming when the agent settles — precisely
// the wait being protected) and a `promptCache` lifetime on the model. Both
// are diagnosed by `warmAdvice` and surfaced in the status line and one
// warning per session.
import { formatRuntime } from "./notify.ts";
import { getRegistry, type Task } from "./registry.ts";

const KEY = Symbol.for("pi-bg-run.warm");
/** The status line's key in pi's footer. */
export const STATUS_KEY = "pi-bg-run";
/** Heartbeat cadence in seconds when `PI_BG_RUN_HEARTBEAT_S` says nothing. */
export const HEARTBEAT_DEFAULT_S = 100;
/** The status is looked at this often regardless, so an ended task clears promptly. */
const CHECK_MS = 10_000;

/** The little surface of pi this module needs; the tests pass a stand-in. */
export type WarmHost = {
	/** Whether the agent is idle (not streaming). */
	isIdle(): boolean;
	/** Footer status text; `undefined` clears. */
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** The persisted `cacheWarming` setting; only `"idle"` warms between runs. */
	cacheWarming(): string | undefined;
	/** The session's model; its `promptCache` lifetimes gate pi's warmer. */
	model(): { promptCache?: { short?: number; long?: number } } | undefined;
};

type WarmState = {
	interval?: ReturnType<typeof setInterval>;
	host?: WarmHost;
	sessionId?: string;
	/** Whether the status line is currently shown. */
	showing: boolean;
	/** When the status text was last refreshed. */
	refreshedAt: number;
	/** The running task ids the shown text names. */
	shownIds: string;
	/** Whether the misconfiguration warning was sent this session. */
	warned: boolean;
};

function state(): WarmState {
	const holder = globalThis as unknown as Record<symbol, WarmState | undefined>;
	return (holder[KEY] ??= { showing: false, refreshedAt: 0, shownIds: "", warned: false });
}

/** Heartbeat cadence in seconds: the default, or `undefined` when disabled (`0`, `off`). */
export function heartbeatSeconds(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.PI_BG_RUN_HEARTBEAT_S;
	if (raw === undefined || raw.trim() === "") return HEARTBEAT_DEFAULT_S;
	if (/^off$/i.test(raw.trim())) return undefined;
	const seconds = Number(raw);
	if (Number.isNaN(seconds)) return HEARTBEAT_DEFAULT_S;
	if (seconds <= 0) return undefined;
	return Math.floor(seconds);
}

/**
 * Why the cache cannot be kept warm in this configuration, or `undefined` when
 * pi's warmer can do the job. The two gates mirror pi's own: the `"idle"`
 * warming mode and a `promptCache` lifetime for the retention tier in use.
 */
export function warmAdvice(host: WarmHost, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const mode = host.cacheWarming() ?? "streaming";
	if (mode === "off") return `cache warming is off in settings (set "cacheWarming": "idle")`;
	if (mode !== "idle") return `set the global setting "cacheWarming": "idle" (now "${mode}", which stops when the agent settles)`;
	const tier = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	if (host.model()?.promptCache?.[tier] === undefined) {
		return `the model declares no ${tier}-tier prompt-cache lifetime (add "promptCache" to its modelOverrides)`;
	}
	return undefined;
}

/** The heartbeat text: what is running and whether the cache is being kept warm. */
export function statusLine(tasks: Task[], isIdle: boolean, advice: string | undefined, now = Date.now()): string {
	const ids = tasks.map((task) => task.id).join(", ");
	const longest = Math.max(...tasks.map((task) => (task.endedAt ?? now) - task.startedAt));
	const base = `bg task${tasks.length === 1 ? "" : "s"} ${ids} ${tasks.length === 1 ? "is" : "are"} still running (${formatRuntime(longest)})`;
	if (advice !== undefined) return `${base} · cache warming unavailable: ${advice}`;
	return isIdle ? `Cache warming on: ${base}, standby.` : `Cache warming on: ${base}.`;
}

/** Pi's cache-warming decision overridden to "warm" while any task runs. */
export function warmDecision(tasks: Iterable<Task>): "warm" | undefined {
	for (const task of tasks) if (task.state === "running") return "warm";
	return undefined;
}

function runningTasks(): Task[] {
	return [...getRegistry().tasks.values()].filter((task) => task.state === "running");
}

/**
 * Arm the heartbeat for this session (each `/reload` calls it again). A new
 * session resets the warning; the host is replaced so a stale context is never
 * used. Nothing is armed when `PI_BG_RUN_HEARTBEAT_S` disables the heartbeat.
 */
export function warmStart(sessionId: string, host: WarmHost): void {
	const warm = state();
	if (warm.sessionId !== sessionId) {
		warm.sessionId = sessionId;
		warm.warned = false;
		warm.refreshedAt = 0;
		warm.shownIds = "";
	}
	warm.host = host;
	if (warm.interval === undefined) {
		const seconds = heartbeatSeconds();
		if (seconds === undefined) return;
		warm.interval = setInterval(heartbeatTick, Math.min(seconds * 1000, CHECK_MS));
		warm.interval.unref?.();
	}
}

/** Disarm the heartbeat and clear the status line at session end. */
export function warmStop(): void {
	const warm = state();
	if (warm.interval !== undefined) {
		clearInterval(warm.interval);
		warm.interval = undefined;
	}
	if (warm.showing) {
		try {
			warm.host?.setStatus(STATUS_KEY, undefined);
		} catch {
			// presentation only
		}
		warm.showing = false;
	}
}

/** One heartbeat look: show the status while tasks run, clear it when they are gone. Exported for tests. */
export function heartbeatTick(now = Date.now()): void {
	const warm = state();
	const host = warm.host;
	if (host === undefined) return;
	const tasks = runningTasks();
	if (tasks.length === 0) {
		if (warm.showing) {
			try {
				host.setStatus(STATUS_KEY, undefined);
			} catch {
				// presentation only
			}
			warm.showing = false;
			warm.shownIds = "";
		}
		return;
	}
	const seconds = heartbeatSeconds();
	if (seconds === undefined) return;
	const ids = tasks.map((task) => task.id).join(", ");
	if (warm.showing && ids === warm.shownIds && now - warm.refreshedAt < seconds * 1000) return;
	warm.refreshedAt = now;
	warm.shownIds = ids;
	try {
		host.setStatus(STATUS_KEY, statusLine(tasks, host.isIdle(), warmAdvice(host), now));
		warm.showing = true;
	} catch {
		// presentation only
	}
}

/** Warn once per session when tasks run but the cache cannot be kept warm. */
export function warmSettled(): void {
	const warm = state();
	const host = warm.host;
	if (host === undefined || warm.warned) return;
	if (runningTasks().length === 0) return;
	const advice = warmAdvice(host);
	if (advice === undefined) return;
	warm.warned = true;
	try {
		host.notify(`pi-bg-run: cache warming unavailable — ${advice}. Long idle waits will pay a cache miss at completion.`, "warning");
	} catch {
		// presentation only
	}
}
