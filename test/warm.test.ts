// Cache-warming mode against a fake host: the forced "warm" decision while a
// task runs, the heartbeat status line and its configuration diagnosis, and
// the one warning when the cache cannot be kept warm.
import assert from "node:assert/strict";
import { test } from "node:test";

import { getRegistry, type Task } from "../src/registry.ts";
import {
	HEARTBEAT_DEFAULT_S,
	heartbeatSeconds,
	heartbeatTick,
	STATUS_KEY,
	statusLine,
	warmAdvice,
	warmDecision,
	warmSettled,
	warmStart,
	warmStop,
	type WarmHost,
} from "../src/warm.ts";

// The lifecycle tests assume the default cadence; the cadence tests pass env.
delete process.env.PI_BG_RUN_HEARTBEAT_S;

function makeTask(id: string, startedAt: number, state: Task["state"] = "running"): Task {
	return {
		id,
		command: `command ${id}`,
		cwd: ".",
		logPath: "x.log",
		scriptPath: "x.sh",
		pid: 1,
		nonce: "n",
		scanFrom: 0,
		startedAt,
		state,
		readPosition: 0,
		notified: false,
	};
}

type HostCalls = { key: string; text: string | undefined }[];

function fakeHost(options: { cacheWarming?: string; promptCache?: { short?: number; long?: number }; isIdle?: boolean } = {}) {
	const status: HostCalls = [];
	const notices: { message: string; type?: string } = [];
	const host: WarmHost = {
		isIdle: () => options.isIdle ?? true,
		setStatus: (key, text) => {
			status.push({ key, text });
		},
		notify: (message, type) => {
			notices.push({ message, ...(type === undefined ? {} : { type }) });
		},
		cacheWarming: () => options.cacheWarming,
		model: () => (options.promptCache === undefined ? undefined : { promptCache: options.promptCache }),
	};
	return { host, status, notices };
}

test("heartbeatSeconds honors PI_BG_RUN_HEARTBEAT_S", () => {
	assert.equal(heartbeatSeconds({}), HEARTBEAT_DEFAULT_S);
	assert.equal(heartbeatSeconds({ PI_BG_RUN_HEARTBEAT_S: "" }), HEARTBEAT_DEFAULT_S);
	assert.equal(heartbeatSeconds({ PI_BG_RUN_HEARTBEAT_S: "45" }), 45);
	assert.equal(heartbeatSeconds({ PI_BG_RUN_HEARTBEAT_S: "junk" }), HEARTBEAT_DEFAULT_S);
	assert.equal(heartbeatSeconds({ PI_BG_RUN_HEARTBEAT_S: "0" }), undefined);
	assert.equal(heartbeatSeconds({ PI_BG_RUN_HEARTBEAT_S: "off" }), undefined);
});

test("warmAdvice diagnoses why the cache cannot be kept warm", () => {
	const promptCache = { short: 300 };
	assert.equal(warmAdvice(fakeHost({ cacheWarming: "idle", promptCache }).host, {}), undefined);
	assert.match(warmAdvice(fakeHost({ cacheWarming: "off", promptCache }).host, {}) ?? "", /off in settings/);
	// The unset default is "streaming", which stops when the agent settles —
	// exactly the wait being protected.
	assert.match(warmAdvice(fakeHost({ promptCache }).host, {}) ?? "", /"cacheWarming": "idle"/);
	assert.match(warmAdvice(fakeHost({ cacheWarming: "streaming", promptCache }).host, {}) ?? "", /stops when the agent settles/);
	assert.match(warmAdvice(fakeHost({ cacheWarming: "idle" }).host, {}) ?? "", /prompt-cache lifetime/);
	// The retention tier in use must have a lifetime.
	assert.match(warmAdvice(fakeHost({ cacheWarming: "idle", promptCache }).host, { PI_CACHE_RETENTION: "long" }) ?? "", /long-tier/);
	assert.equal(
		warmAdvice(fakeHost({ cacheWarming: "idle", promptCache: { short: 300, long: 3600 } }).host, { PI_CACHE_RETENTION: "long" }),
		undefined,
	);
});

test("statusLine is the heartbeat text", () => {
	const now = 1_000_000_000;
	const task = makeTask("bg-89", now - 283_000); // 4m 43s
	assert.equal(statusLine([task], true, undefined, now), "Cache warming on: bg task bg-89 is still running (4m 43s), standby.");
	assert.equal(statusLine([task], false, undefined, now), "Cache warming on: bg task bg-89 is still running (4m 43s).");
	const other = makeTask("bg-90", now - 5_000);
	assert.equal(
		statusLine([task, other], true, undefined, now),
		"Cache warming on: bg tasks bg-89, bg-90 are still running (4m 43s), standby.",
	);
	assert.match(statusLine([task], true, 'set the global setting "cacheWarming": "idle"', now), /cache warming unavailable: set the global setting/);
});

test("warmDecision warms only while a task runs", () => {
	assert.equal(warmDecision([]), undefined);
	assert.equal(warmDecision([makeTask("bg-1", 0, "exited"), makeTask("bg-2", 0, "killed")]), undefined);
	assert.equal(warmDecision([makeTask("bg-3", 0, "running"), makeTask("bg-4", 0, "exited")]), "warm");
});

test("the heartbeat shows the status while tasks run and clears it when they end", () => {
	const { host, status } = fakeHost({ cacheWarming: "idle", promptCache: { short: 300 } });
	const registry = getRegistry();
	registry.tasks.clear();
	warmStart("warm-session", host);
	const t0 = Date.now();
	const task = makeTask("bg-7", t0 - 1000);
	registry.tasks.set(task.id, task);
	heartbeatTick(t0);
	assert.equal(status.length, 1);
	assert.equal(status[0].key, STATUS_KEY);
	assert.match(status[0].text ?? "", /bg-7 is still running \(1\.0s\), standby\./);
	// A look inside the heartbeat window does not refresh the text.
	heartbeatTick(t0 + 5_000);
	assert.equal(status.length, 1);
	// A change in the running set does.
	const more = makeTask("bg-8", t0 - 1000);
	registry.tasks.set(more.id, more);
	heartbeatTick(t0 + 5_000);
	assert.equal(status.length, 2);
	assert.match(status[1].text ?? "", /bg-7, bg-8 are still running/);
	// The next window refreshes even for the same set (the window restarted
	// with the early refresh above).
	heartbeatTick(t0 + 106_000);
	assert.equal(status.length, 3);
	// When the last task ends the status clears on the next look.
	registry.tasks.clear();
	heartbeatTick(t0 + 207_000);
	assert.equal(status.at(-1)?.text, undefined);
	warmStop();
});

test("PI_BG_RUN_HEARTBEAT_S=0 disables the status line", () => {
	process.env.PI_BG_RUN_HEARTBEAT_S = "0";
	const { host, status } = fakeHost();
	const registry = getRegistry();
	registry.tasks.clear();
	warmStart("warm-disabled-session", host);
	const task = makeTask("bg-9", Date.now());
	registry.tasks.set(task.id, task);
	heartbeatTick();
	assert.equal(status.length, 0);
	warmStop();
	delete process.env.PI_BG_RUN_HEARTBEAT_S;
});

test("the agent settling warns once when the cache cannot be kept warm", () => {
	const registry = getRegistry();
	registry.tasks.clear();
	const warn = fakeHost({ cacheWarming: "streaming", promptCache: { short: 300 } });
	warmStart("warm-warn-session", warn.host);
	registry.tasks.set("bg-9", makeTask("bg-9", Date.now()));
	warmSettled();
	warmSettled();
	assert.equal(warn.notices.length, 1);
	assert.match(warn.notices[0].message, /cache warming unavailable/);
	assert.equal(warn.notices[0].type, "warning");

	// An eligible configuration says nothing, and no task means nothing.
	registry.tasks.clear();
	const fine = fakeHost({ cacheWarming: "idle", promptCache: { short: 300 } });
	warmStart("warm-quiet-session", fine.host);
	warmSettled();
	registry.tasks.set("bg-10", makeTask("bg-10", Date.now()));
	warmSettled();
	assert.equal(fine.notices.length, 0);
	warmStop();
});
