// The Pi-gone watcher. Started detached per task, outside its process tree:
// node bg-watcher.cjs <pi-pid> <task-pid> <nonce> <log-path>. It exits when the
// task's process is gone; when Pi dies first it appends the GONE marker to the
// log and kills the task's tree, so a crashed Pi leaves nothing running. No
// dependencies: it must run from anywhere, on Windows and POSIX alike.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const piPid = Number(process.argv[2]);
const taskPid = Number(process.argv[3]);
const nonce = process.argv[4];
const logPath = process.argv[5];

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function killTree(pid) {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
			windowsHide: true,
			stdio: "ignore",
			timeout: 15000,
		});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// the group is already gone
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// the process is already gone
	}
}

setInterval(() => {
	if (!alive(taskPid)) process.exit(0);
	if (!alive(piPid)) {
		try {
			fs.appendFileSync(logPath, `\n__BG_GONE__:${nonce}\n`);
		} catch {
			// the kill below is what matters
		}
		killTree(taskPid);
		process.exit(0);
	}
}, 1000);
