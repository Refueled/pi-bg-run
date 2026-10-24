// Real-process smoke check, no Pi needed: starts a task through the real
// process layer, polls it to its exit marker, and prints the completion text.
//   node scripts/spike.ts
// Exercises the same path a `bg_run` takes: wrapper script, detached spawn,
// log capture, marker settle, completion message.
import { readOutput } from "../src/output.ts";
import type { PiLike } from "../src/notify.ts";
import { attach, endSession, getRegistry, pollOnce, startTask } from "../src/registry.ts";

const fakePi: PiLike = {
	sendMessage: (message, options) => {
		console.log(`--- completion message (triggerTurn=${options?.triggerTurn}, deliverAs=${options?.deliverAs}) ---`);
		console.log(message.content);
		console.log("---");
	},
};

attach(fakePi, "spike", process.cwd());
const task = await startTask({ command: "sleep 1; echo hello from spike; exit 0", label: "spike", herdr: "none" });
console.log(`started ${task.id} pid=${task.pid}`);
console.log(`log: ${task.logPath}`);
console.log(`script: ${task.scriptPath}`);

// A quick mid-run peek, as `bg_output latest` would do.
await new Promise((resolve) => setTimeout(resolve, 300));
console.log("--- bg_output (mid-run) ---");
console.log(readOutput(task, {}).text);

while (getRegistry().tasks.get(task.id)?.state === "running") {
	pollOnce();
	await new Promise((resolve) => setTimeout(resolve, 200));
}
const settled = getRegistry().tasks.get(task.id);
console.log(`settled: ${settled?.state} exit=${settled?.exitCode}`);
console.log("--- bg_output (final) ---");
console.log(readOutput(task, {}).text);
endSession();
