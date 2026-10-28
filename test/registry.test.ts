// The task lifecycle against a fake process port and a fake Pi: start, settle
// from the log's exit marker, timeout, kill, and that exactly one completion
// message per task wakes the agent.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { wrapperScript } from "../src/launch.ts";
import type { PiLike } from "../src/notify.ts";
import { type ProcessPort, setProcessPort } from "../src/process.ts";
import { type HerdrPort, setHerdrPort } from "../src/herdr.ts";
import {
	attach,
	DEAD_GRACE_MS,
	endSession,
	getRegistry,
	killTask,
	pollOnce,
	startTask,
	type Task,
} from "../src/registry.ts";

process.env.PI_BG_RUN_NO_WATCHER = "1";
process.env.PI_BG_RUN_STATE = mkdtempSync(join(tmpdir(), "pi-bg-run-registry-"));

const launches: { pid: number; logPath: string; scriptPath: string }[] = [];
const killed: number[] = [];
const alive = new Set<number>();

const fakePort: ProcessPort = {
	launch: async (spec) => {
		const pid = 4000 + launches.length;
		alive.add(pid);
		launches.push({ pid, logPath: spec.logPath, scriptPath: spec.scriptPath });
		return pid;
	},
	killTree: (pid) => {
		killed.push(pid);
		alive.delete(pid);
	},
	pidAlive: (pid) => alive.has(pid),
};
setProcessPort(fakePort);

// These tests are the detached path: no Herdr, whatever the environment says.
const noHerdr: HerdrPort = {
	available: () => false,
	createTab: () => {
		throw new Error("no herdr");
	},
	createSplit: () => {
		throw new Error("no herdr");
	},
	runInPane: () => {
		throw new Error("no herdr");
	},
	ensureReady: () => {
		throw new Error("no herdr");
	},
	close: () => undefined,
	rename: () => undefined,
	renameTab: () => undefined,
};
setHerdrPort(noHerdr);

const messages: { content: string; customType: string; options?: { triggerTurn?: boolean; deliverAs?: string } }[] = [];
const fakePi: PiLike = {
	sendMessage: (message, options) => {
		messages.push({ content: message.content, customType: message.customType, options });
	},
};

function completed(task: Task): (typeof messages)[number] | undefined {
	return messages.find((message) => message.content.includes(task.id));
}

test("startTask writes the wrapper and registers a running task", async () => {
	attach(fakePi, "session-test", process.cwd());
	const task = await startTask({ command: 'echo "hi there"', label: "demo" });
	assert.equal(task.state, "running");
	assert.equal(task.label, "demo");
	const script = readFileSync(task.scriptPath, "utf8");
	assert.ok(script.includes(`__PI_BG_RUN_${task.nonce}__`));
	assert.ok(script.includes(`__BG_EXIT__:${task.nonce}:%s`));
	assert.ok(script.includes('echo "hi there"'));
	assert.equal(launches.length, 1);
	assert.equal(launches[0].logPath, task.logPath);
});

test("the poller settles a task from its exit marker and notifies once", async () => {
	const task = await startTask({ command: "exit 3" });
	writeFileSync(task.logPath, `output here\n__BG_EXIT__:${task.nonce}:3\n`);
	pollOnce();
	assert.equal(task.state, "exited");
	assert.equal(task.exitCode, 3);
	const message = completed(task);
	assert.ok(message !== undefined);
	assert.equal(message.customType, "pi-bg-run");
	assert.equal(message.options?.triggerTurn, true);
	assert.equal(message.options?.deliverAs, "steer");
	assert.ok(message.content.includes("exited (code 3)"));
	assert.ok(!message.content.includes("__BG_EXIT__"));
	// A second poll sends nothing more.
	pollOnce();
	assert.equal(messages.filter((m) => m.content.includes(task.id)).length, 1);
});

test("markers with another nonce or a non-numeric code do not settle the task", async () => {
	const task = await startTask({ command: "cat" });
	writeFileSync(task.logPath, `__BG_EXIT__:fakenonce:0\n__BG_EXIT__:${task.nonce}:zero\n`, { flag: "w" });
	pollOnce();
	assert.equal(task.state, "running");
	// The wrapper's own marker settles it.
	writeFileSync(task.logPath, `\n__BG_EXIT__:${task.nonce}:0\n`, { flag: "w" });
	pollOnce();
	assert.equal(task.state, "exited");
	assert.equal(task.exitCode, 0);
});

test("a task past its deadline is killed as timed out and notified", async () => {
	const task = await startTask({ command: "sleep 100", timeoutSeconds: 0.05 });
	await new Promise((resolve) => setTimeout(resolve, 80));
	pollOnce();
	assert.equal(task.state, "killed");
	assert.equal(task.reason, "timed out");
	assert.ok(killed.includes(task.pid));
	assert.ok(completed(task)?.content.includes("killed (timed out)"));
});

test("killTask kills the tree and reports killed by agent", async () => {
	const task = await startTask({ command: "sleep 100" });
	killTask(task, "killed by agent");
	assert.equal(task.state, "killed");
	assert.equal(task.reason, "killed by agent");
	assert.ok(killed.includes(task.pid));
	assert.ok(completed(task)?.content.includes("killed (killed by agent)"));
	// Killing again changes nothing.
	killTask(task, "killed by agent");
	assert.equal(messages.filter((m) => m.content.includes(task.id)).length, 1);
});

test("a task whose pid died without a marker settles as exit unknown", async () => {
	const task = await startTask({ command: "crash" });
	alive.delete(task.pid);
	task.deadSince = Date.now() - DEAD_GRACE_MS - 1000;
	pollOnce();
	assert.equal(task.state, "exit-unknown");
	assert.ok(completed(task)?.content.includes("exit unknown"));
});

test("endSession kills running tasks silently and stops the poller", async () => {
	const task = await startTask({ command: "sleep 100" });
	endSession();
	assert.equal(task.state, "killed");
	assert.equal(task.reason, "killed by user");
	assert.equal(completed(task), undefined);
	assert.equal(getRegistry().poller, undefined);
});

test("another session kills and forgets the old tasks and restarts ids at bg-1", async () => {
	const old = await startTask({ command: "sleep 100" });
	endSession(); // what session_shutdown does; the map still held the task until now
	assert.equal(getRegistry().tasks.has(old.id), true);
	attach(fakePi, "session-other", process.cwd());
	assert.equal(getRegistry().tasks.has(old.id), false);
	assert.equal(old.state, "killed");
	assert.equal(old.reason, "killed by user");
	assert.equal(completed(old), undefined);
	// The new conversation's list starts fresh: ids and `bg_tasks` are its own.
	const fresh = await startTask({ command: "echo fresh" });
	assert.equal(fresh.id, "bg-1");
});

test("wrapperScript runs the command in a subshell and appends the marker", () => {
	const script = wrapperScript("exit 5", "nonceX");
	assert.ok(script.includes("( eval \"$__pi_bg_run_cmd\" )"));
	assert.ok(script.includes("__BG_EXIT__:nonceX:%s"));
	assert.ok(script.includes("__PI_BG_RUN_nonceX__"));
	// The script redirects its own output to the log; no handle crosses the spawn.
	assert.ok(script.includes('exec >>"$1" 2>&1'));
	// Command text with quotes and heredoc-hostile content stays literal.
	const tricky = wrapperScript('echo "$HOME" `date` # comment', "nonceX");
	assert.ok(tricky.includes('echo "$HOME" `date` # comment'));
});
