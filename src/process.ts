// The process layer: the extension's only contact with real processes. It has
// three operations, at the level of launch, tree kill and liveness. Windows
// kills a whole tree with `taskkill /T /F` and has no POSIX signals; POSIX
// launches detached so the wrapper leads its own process group and the group is
// signalled as a unit. Everything above it (the poller, timeouts, the crash
// watcher) runs against this port, and the tests swap in a fake.
import { spawn, spawnSync } from "node:child_process";

export type LaunchSpec = {
	/** The shell that runs the wrapper script (Pi's own shell when it reports one). */
	shell: string;
	/** The generated wrapper script; the command text travels inside it. */
	scriptPath: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Where the task's stdout and stderr go. */
	logPath: string;
};

export type ProcessPort = {
	/** Start a task detached with its output on the log; resolves to its pid. */
	launch(spec: LaunchSpec): Promise<number>;
	/** Stop the process and everything it started. */
	killTree(pid: number): void;
	/** Whether the process exists. */
	pidAlive(pid: number): boolean;
};

const WINDOWS = process.platform === "win32";

async function realLaunch(spec: LaunchSpec): Promise<number> {
	// The wrapper script redirects its own output to the log ($1): passing a
	// file handle through the spawn is unreliable with Git Bash on Windows.
	const child = spawn(spec.shell, [spec.scriptPath, spec.logPath], {
		cwd: spec.cwd,
		env: spec.env,
		// Detached: a new process group (POSIX: its own session) that Ctrl+C
		// and the terminal's foreground job do not reach.
		detached: true,
		windowsHide: true,
		stdio: ["ignore", "ignore", "ignore"],
	});
	return await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			if (child.pid === undefined) reject(new Error(`failed to start ${spec.shell}`));
			else resolve(child.pid);
		});
	});
}

function realKillTree(pid: number): void {
	if (WINDOWS) {
		// `/T` walks the live parent-child tree; no signal exists for console
		// trees, so the kill is immediate (`/F`).
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

function realPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

export const realPort: ProcessPort = {
	launch: realLaunch,
	killTree: realKillTree,
	pidAlive: realPidAlive,
};

let current: ProcessPort = realPort;

/** The port the extension uses: the real one unless the test harness replaced it. */
export function processPort(): ProcessPort {
	return current;
}

/** For the test harness only: swap the port. Nothing in the extension calls this. */
export function setProcessPort(port: ProcessPort): void {
	current = port;
}
