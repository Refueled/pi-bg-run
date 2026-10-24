// One-shot diagnosis: reproduce exactly what startTask's Herdr branch does in
// a scratch tab, and show every step's result. Closes its tab when done.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneCommandLine } from "../src/herdr.ts";
import { wrapperScript } from "../src/launch.ts";

function sh(args: string[]): string {
	const r = spawnSync("herdr", args, { encoding: "utf8", windowsHide: true });
	return `status=${r.status} out=${JSON.stringify((r.stdout ?? "").trim())} err=${JSON.stringify((r.stderr ?? "").trim())}`;
}

const dir = join(tmpdir(), "pi-bg-run-exp");
mkdirSync(dir, { recursive: true });
const script = `${dir}/exp.cmd.sh`;
const log = `${dir}/exp.log`;
writeFileSync(script, wrapperScript("echo exp-typed-ran", "expnonce", "pane"));
writeFileSync(log, "");

const create = spawnSync("herdr", ["tab", "create", "--label", "pi-bg-exp", "--no-focus"], { encoding: "utf8", windowsHide: true });
const json = JSON.parse(create.stdout);
const paneId = json.result.root_pane.pane_id;
const tabId = json.result.tab.tab_id;
console.log("tab:", tabId, "pane:", paneId);

// Exactly what the code sees right after createTab (the shell-name race lives here).
const info1 = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], { encoding: "utf8", windowsHide: true });
console.log("process-info@create:", (info1.stdout ?? "").trim().slice(0, 300));

console.log("probe:", sh(["pane", "run", paneId, "echo __PI_BG_READY_exp"]));
console.log("wait:", sh(["pane", "wait-output", paneId, "--match", "__PI_BG_READY_exp", "--timeout", "10000"]));
const info2 = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], { encoding: "utf8", windowsHide: true });
console.log("process-info@ready:", (info2.stdout ?? "").trim().slice(0, 300));

const line = paneCommandLine("pwsh.exe", "C:\\Program Files\\Git\\bin\\bash.exe", script, log);
console.log("LINE:", JSON.stringify(line));
console.log("run:", sh(["pane", "run", paneId, line]));
await new Promise((resolve) => setTimeout(resolve, 3000));
const read = spawnSync("herdr", ["pane", "read", paneId, "--source", "recent", "--lines", "12"], { encoding: "utf8", windowsHide: true });
console.log("PANE:\n" + (read.stdout ?? ""));
console.log("LOG:", JSON.stringify(readFileSync(log, "utf8")), "size:", statSync(log).size);
const close = spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8", windowsHide: true });
console.log("close:", close.status);
