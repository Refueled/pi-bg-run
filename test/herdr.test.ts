// The Herdr layer against a fake Herdr port: the typed line's quoting, the
// pane wrapper's tee, and the tab lifecycle — any end closes the tab,
// `keepOpen` keeps a failed one, relabelled, kill closes it, and a Herdr failure
// falls back to detached.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type HerdrPort, type HerdrTask, paneCommandLine, setHerdrPort } from "../src/herdr.ts";
import { wrapperScript } from "../src/launch.ts";
import type { PiLike } from "../src/notify.ts";
import { type ProcessPort, setProcessPort } from "../src/process.ts";
import { attach, killTask, pollOnce, startTask } from "../src/registry.ts";

process.env.PI_BG_RUN_NO_WATCHER = "1";
process.env.PI_BG_RUN_STATE = mkdtempSync(join(tmpdir(), "pi-bg-run-herdr-"));

const launches: number[] = [];
const killed: number[] = [];
const fakePort: ProcessPort = {
	launch: async () => {
		const pid = 7000 + launches.length;
		launches.push(pid);
		return pid;
	},
	killTree: (pid) => killed.push(pid),
	pidAlive: () => true,
};
setProcessPort(fakePort);

type HerdrCall = { op: string; args: string[] };
const herdrCalls: HerdrCall[] = [];
let herdrWorks = true;

function target(paneId: string, tabId?: string): HerdrTask {
	return { paneId, ...(tabId === undefined ? {} : { tabId }), shellPid: 4242, shellName: "pwsh.exe" };
}

let seq = 1;

const fakeHerdr: HerdrPort = {
	available: () => herdrWorks,
	createTab: (label, cwd) => {
		herdrCalls.push({ op: "createTab", args: [label, cwd] });
		seq++;
		return target(`w1:p${seq}`, `w1:t${seq}`);
	},
	createSplit: (cwd) => {
		herdrCalls.push({ op: "createSplit", args: [cwd] });
		seq++;
		return target(`w1:p${seq}`);
	},
	runInPane: (paneId, line) => {
		herdrCalls.push({ op: "runInPane", args: [paneId, line] });
	},
	ensureReady: (paneId) => {
		herdrCalls.push({ op: "ensureReady", args: [paneId] });
		return { shellPid: 4242, shellName: "pwsh.exe" };
	},
	close: (t) => {
		herdrCalls.push({ op: "close", args: [t.paneId, t.tabId ?? ""] });
	},
	rename: (paneId, title) => {
		herdrCalls.push({ op: "rename", args: [paneId, title] });
	},
	renameTab: (tabId, label) => {
		herdrCalls.push({ op: "renameTab", args: [tabId, label] });
	},
};
setHerdrPort(fakeHerdr);

const messages: string[] = [];
const fakePi: PiLike = { sendMessage: (message) => messages.push(message.content) };

test("paneCommandLine quotes for the pane's shell family", () => {
	const pwsh = paneCommandLine("pwsh.exe", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\s.sh", "C:\\l.log");
	assert.equal(pwsh, `& 'C:\\Program Files\\Git\\bin\\bash.exe' 'C:\\s.sh' 'C:\\l.log'`);
	const cmd = paneCommandLine("cmd.exe", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\s.sh", "C:\\l.log");
	assert.equal(cmd, `"C:\\Program Files\\Git\\bin\\bash.exe" "C:\\s.sh" "C:\\l.log"`);
	const sh = paneCommandLine("bash.exe", "/c/Program Files/Git/bin/bash", "/s.sh", "/l.log");
	assert.equal(sh, `'/c/Program Files/Git/bin/bash' '/s.sh' '/l.log'`);
	// A quote in a value is escaped for its shell.
	assert.ok(paneCommandLine("bash.exe", "it's", "s", "l").includes(`'it'\\''s'`));
	assert.ok(paneCommandLine("pwsh.exe", "it's", "s", "l").includes(`'it''s'`));
});

test("the pane wrapper tees output to the log and keeps the marker ordered", () => {
	const script = wrapperScript("echo hi", "nonceY", "pane");
	assert.ok(script.includes(`} 2>&1 | tee "$1"`));
	assert.ok(script.includes("__BG_EXIT__:nonceY:%s"));
	assert.ok(!script.includes("exec >>"));
	assert.ok(script.includes('echo hi'));
	// The detached wrapper is unchanged.
	assert.ok(wrapperScript("echo hi", "nonceY").includes('exec >>"$1" 2>&1'));
});

test("generated wrappers parse as shell", (t) => {
	let probe: ReturnType<typeof spawnSync> | undefined;
	try {
		probe = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" });
	} catch {
		t.skip("bash not available");
		return;
	}
	if (probe.status !== 0) {
		t.skip("bash not available");
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "pi-bg-run-parse-"));
	for (const mode of ["detached", "pane"] as const) {
		const path = join(dir, `check-${mode}.sh`);
		writeFileSync(path, wrapperScript("echo hi; exit 3", "nonceZ", mode));
		const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
		assert.equal(result.status, 0, `bash -n rejected the ${mode} wrapper: ${result.stderr}`);
	}
});

test("a tab task runs in Herdr and never spawns detached", async () => {
	attach(fakePi, "herdr-session", process.cwd());
	const task = await startTask({ command: "echo hi", label: "demo", herdr: "tab" });
	assert.equal(task.herdr?.tabId, "w1:t2");
	assert.equal(task.pid, 4242);
	assert.equal(launches.length, 0);
	const run = herdrCalls.find((call) => call.op === "runInPane");
	assert.ok(run !== undefined);
	assert.equal(run.args[0], "w1:p2");
	assert.ok(run.args[1].includes(task.scriptPath));
	assert.ok(herdrCalls.some((call) => call.op === "ensureReady" && call.args[0] === "w1:p2"));
	assert.ok(readFileSync(task.scriptPath, "utf8").includes("tee"));
	const created = herdrCalls.find((call) => call.op === "createTab");
	assert.deepEqual(created?.args, ["demo", process.cwd()]);
});

test("a tab task closes its tab on any outcome; keepOpen keeps a failed one relabelled", async () => {
	const ok = await startTask({ command: "true", herdr: "tab" });
	writeFileSync(ok.logPath, `\n__BG_EXIT__:${ok.nonce}:0\n`);
	pollOnce();
	assert.equal(ok.state, "exited");
	assert.ok(herdrCalls.some((call) => call.op === "close" && call.args[0] === ok.herdr?.paneId));
	assert.ok(messages.some((text) => text.includes(ok.id)));

	// A failed tab closes too: its output lives on in the log and the
	// completion message, so nothing piles up for the agent to clean up.
	const bad = await startTask({ command: "false", herdr: "tab" });
	writeFileSync(bad.logPath, `\n__BG_EXIT__:${bad.nonce}:1\n`);
	pollOnce();
	assert.equal(bad.state, "exited");
	assert.equal(bad.exitCode, 1);
	assert.ok(herdrCalls.some((call) => call.op === "close" && call.args[0] === bad.herdr?.paneId));
	assert.ok(!herdrCalls.some((call) => call.op === "rename" && call.args[0] === bad.herdr?.paneId));

	// `keepOpen` is the exception: a failed tab stays, marked to be found.
	const kept = await startTask({ command: "false", herdr: "tab", keepOpen: true });
	writeFileSync(kept.logPath, `\n__BG_EXIT__:${kept.nonce}:1\n`);
	pollOnce();
	assert.ok(!herdrCalls.some((call) => call.op === "close" && call.args[0] === kept.herdr?.paneId));
	const renamed = herdrCalls.find((call) => call.op === "rename" && call.args[0] === kept.herdr?.paneId);
	assert.ok(renamed !== undefined);
	assert.ok(renamed.args[1].includes("bg-"));
	assert.ok(renamed.args[1].includes("exited (code 1)"));
	// The pane title alone still reads as a live task in the tab strip, so the
	// tab is relabelled with the same text.
	const relabelled = herdrCalls.find((call) => call.op === "renameTab" && call.args[0] === kept.herdr?.tabId);
	assert.ok(relabelled !== undefined);
	assert.equal(relabelled.args[1], renamed.args[1]);

	// keepOpen never keeps a successful tab.
	const keptOk = await startTask({ command: "true", herdr: "tab", keepOpen: true });
	writeFileSync(keptOk.logPath, `\n__BG_EXIT__:${keptOk.nonce}:0\n`);
	pollOnce();
	assert.ok(herdrCalls.some((call) => call.op === "close" && call.args[0] === keptOk.herdr?.paneId));
});

test("killing a tab task closes the tab", async () => {
	const task = await startTask({ command: "sleep 100", herdr: "tab" });
	killTask(task, "killed by agent");
	assert.equal(task.state, "killed");
	assert.ok(herdrCalls.some((call) => call.op === "close" && call.args[0] === task.herdr?.paneId));
	assert.ok(messages.some((text) => text.includes(task.id)));
});

test("a split task closes its pane on success", async () => {
	const task = await startTask({ command: "true", herdr: "pane" });
	assert.equal(task.herdr?.tabId, undefined);
	writeFileSync(task.logPath, `\n__BG_EXIT__:${task.nonce}:0\n`);
	pollOnce();
	assert.ok(herdrCalls.some((call) => call.op === "close" && call.args[1] === "" && call.args[0] === task.herdr?.paneId));
});

test("a kept-open split is marked at its pane only: it has no tab of its own", async () => {
	const relabelsBefore = herdrCalls.filter((call) => call.op === "renameTab").length;
	const task = await startTask({ command: "false", herdr: "pane", keepOpen: true });
	writeFileSync(task.logPath, `\n__BG_EXIT__:${task.nonce}:1\n`);
	pollOnce();
	assert.ok(!herdrCalls.some((call) => call.op === "close" && call.args[0] === task.herdr?.paneId));
	assert.ok(herdrCalls.some((call) => call.op === "rename" && call.args[0] === task.herdr?.paneId));
	assert.equal(herdrCalls.filter((call) => call.op === "renameTab").length, relabelsBefore);
});

test("a Herdr failure falls back to a detached task", async () => {
	herdrWorks = false;
	const task = await startTask({ command: "echo detached", herdr: "tab" });
	assert.equal(task.herdr, undefined);
	assert.equal(launches.length, 1);
	herdrWorks = true;
});

test("the marker settles a tab task like a detached one", async () => {
	const started = await startTask({ command: "echo hi", herdr: "tab" });
	assert.equal(started.state, "running");
	// The pane wrapper's marker reaches the log through tee; the registry's
	// scan is mode-agnostic.
	writeFileSync(started.logPath, `output\n__BG_EXIT__:${started.nonce}:0\n`);
	pollOnce();
	assert.equal(started.state, "exited");
	assert.equal(started.exitCode, 0);
});
