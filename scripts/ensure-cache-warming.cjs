#!/usr/bin/env node
// Installed-package setup: pi's prompt cache only stays warm across an idle
// background-task wait when the global `cacheWarming` setting is `"idle"`, so
// this offers to set it while the package installs. Pi installs package
// dependencies with a plain package-manager run in the checkout, so this
// `postinstall` fires during `pi install` and `pi update` — interactive
// terminals are asked first ("[Y/n]"), anywhere else the setting is adjusted
// silently and reported. An explicit `"off"` is always respected.
//
// `PI_BG_RUN_SETUP` forces one behavior: `off` (never touch settings), `auto`
// (adjust silently even on a terminal), `prompt` (ask when interactive; the
// default). Never fails the install, never creates a pi config that is not
// there, and never rewrites a settings file it cannot parse.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const log = (text) => console.log(`pi-bg-run setup: ${text}`);

/** `<agent-dir>/settings.json`, where pi reads user-level settings. */
function settingsPath(env = process.env) {
	const dir = env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(dir, "settings.json");
}

/** Normalize `PI_BG_RUN_SETUP` to one of the three modes. */
function setupMode(env = process.env) {
	const raw = (env.PI_BG_RUN_SETUP ?? "").trim().toLowerCase();
	if (raw === "off" || raw === "auto" || raw === "prompt") return raw;
	return "prompt";
}

/** What to do about the current `cacheWarming` value. */
function decide(current, { setup, interactive }) {
	if (setup === "off") return { action: "skip", note: "left settings alone (PI_BG_RUN_SETUP=off)" };
	if (current === "idle") return { action: "skip", note: `cacheWarming is already "idle"` };
	if (current === "off") return { action: "skip", note: `cacheWarming stays "off" (explicit opt-out)` };
	if (setup === "prompt" && interactive) return { action: "prompt" };
	return { action: "set" };
}

function ask(question) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function main(env = process.env) {
	return (async () => {
		const file = settingsPath(env);
		if (!fs.existsSync(file)) {
			log(`no pi settings at ${file}; nothing to change`);
			return;
		}
		let settings;
		try {
			settings = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
		} catch {
			log(`could not parse ${file}; set "cacheWarming": "idle" there by hand to enable cache warming`);
			return;
		}
		if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
			log(`${file} is not a settings object; left it untouched`);
			return;
		}
		const decision = decide(settings.cacheWarming, {
			setup: setupMode(env),
			interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		});
		if (decision.action === "skip") {
			log(decision.note);
			return;
		}
		if (decision.action === "prompt") {
			const answer = await ask(
				`Set "cacheWarming": "idle" in ${file}? Keeps the prompt cache warm while background tasks run. [Y/n] `,
			);
			if (answer !== "" && !/^y(es)?$/i.test(answer)) {
				log(`left settings alone; set "cacheWarming": "idle" in ${file} to enable cache warming`);
				return;
			}
		}
		settings.cacheWarming = "idle";
		fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
		log(`set "cacheWarming": "idle" in ${file} (takes effect in new pi sessions)`);
	})();
}

if (require.main === module) {
	// The install must never fail because of setup.
	main().catch((error) => log(`could not adjust settings: ${error?.message ?? error}`));
}

module.exports = { settingsPath, setupMode, decide, main };
