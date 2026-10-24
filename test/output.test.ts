// `bg_output`'s reader: incremental paging, the withheld half-written line,
// `latest`, `filter`, and that protocol markers never surface.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readOutput, taskTail } from "../src/output.ts";
import type { Task } from "../src/registry.ts";

const NONCE = "nonce1";

function makeTask(logPath: string, state: Task["state"] = "running"): Task {
	return {
		id: "bg-1",
		command: "echo hi",
		cwd: ".",
		logPath,
		scriptPath: logPath + ".sh",
		pid: 1234,
		nonce: NONCE,
		scanFrom: 0,
		startedAt: Date.now(),
		state,
		readPosition: 0,
		notified: false,
	};
}

function logFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bg-run-test-"));
	const path = join(dir, "bg-1.log");
	writeFileSync(path, content);
	return path;
}

test("readOutput pages forward and only moves past what it returned", () => {
	const task = makeTask(logFile("line1\nline2\n"));
	const first = readOutput(task, {});
	assert.ok(first.text.includes("line1"));
	assert.ok(first.text.includes("line2"));
	assert.equal(first.data.unread_bytes, 0);
	// A second call has nothing new.
	const second = readOutput(task, {});
	assert.ok(second.text.includes("(no new output)"));
});

test("readOutput withholds a running task's half-written last line", () => {
	const task = makeTask(logFile("line1\npart"));
	const read = readOutput(task, {});
	assert.ok(read.text.includes("line1"));
	assert.ok(!read.text.includes("part"));
	assert.equal(read.data.unread_bytes, "part".length);
	assert.equal(read.data.truncated, true);
	// The rest arrives with its newline.
	writeFileSync(task.logPath, "line1\npartial line\n");
	const more = readOutput(task, {});
	assert.ok(more.text.includes("partial line"));
	assert.equal(more.data.unread_bytes, 0);
	assert.equal(more.data.truncated, false);
});

test("readOutput latest jumps to the newest output", () => {
	const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
	const task = makeTask(logFile(`${big}\n`));
	const read = readOutput(task, { latest: true });
	assert.ok(read.text.includes("line 3999"));
	assert.ok(!read.text.includes("line 0\n"));
	assert.equal(read.data.truncated, true);
	assert.equal(read.data.unread_bytes, 0);
});

test("readOutput filter keeps only matching lines and says how many", () => {
	const task = makeTask(logFile("pass a\nfail b\npass c\n"));
	const read = readOutput(task, { filter: "^pass" });
	assert.ok(read.text.includes("pass a"));
	assert.ok(!read.text.includes("fail b"));
	assert.ok(read.text.includes("[filter: 2 of 3 lines matched]"));
});

test("readOutput never surfaces the exit marker and reports the settled state", () => {
	const task = makeTask(logFile(`out\n__BG_EXIT__:${NONCE}:2\n`), "running");
	const marker = readOutput(task, {});
	assert.ok(!marker.text.includes("__BG_EXIT__"));
	// Settled by the registry in the meantime: the marker is stripped, state reported.
	task.state = "exited";
	task.exitCode = 2;
	const read = readOutput(task, {});
	assert.ok(read.text.includes("exited (code 2)"));
	assert.ok(!read.text.includes("__BG_EXIT__"));
	assert.equal(read.data.exit_code, 2);
	assert.equal(read.data.unread_bytes, 0);
});

test("taskTail returns the end of the log without the marker", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
	const task = makeTask(logFile(`${lines.join("\n")}\n__BG_EXIT__:${NONCE}:0\n`), "exited");
	const tail = taskTail(task, 5, 4096);
	assert.ok(tail.text.endsWith("line 99"));
	assert.ok(!tail.text.includes("__BG_EXIT__"));
	assert.equal(tail.cut, true);
});
