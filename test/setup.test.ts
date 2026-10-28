// The postinstall setup script: the decision it makes about `cacheWarming`,
// and end-to-end runs against a throwaway PI_CODING_AGENT_DIR (spawned with
// piped stdio, exactly like `pi install` sees it — non-interactive, silent).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const script = join(import.meta.dirname, "..", "scripts", "ensure-cache-warming.cjs");
const { settingsPath, setupMode, decide } = require(script) as {
	settingsPath: (env?: NodeJS.ProcessEnv) => string;
	setupMode: (env?: NodeJS.ProcessEnv) => string;
	decide: (current: string | undefined, options: { setup: string; interactive: boolean }) => { action: string; note?: string };
};

function runSetup(dir: string, extra: NodeJS.ProcessEnv = {}) {
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir, ...extra };
	// The host must never leak a mode into the run under test.
	if (extra.PI_BG_RUN_SETUP === undefined) delete env.PI_BG_RUN_SETUP;
	const result = spawnSync(process.execPath, [script], { encoding: "utf8", env });
	assert.equal(result.status, 0, `setup must never fail an install: ${result.stderr}`);
	return result.stdout;
}

function settingsDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-bg-run-setup-"));
}

test("settingsPath and setupMode read the documented configuration", () => {
	assert.match(settingsPath({ PI_CODING_AGENT_DIR: "X:/pi" }), /X:[\\/]pi[\\/]settings\.json$/);
	assert.match(settingsPath({}), /[\\/]settings\.json$/);
	assert.equal(setupMode({}), "prompt");
	assert.equal(setupMode({ PI_BG_RUN_SETUP: "auto" }), "auto");
	assert.equal(setupMode({ PI_BG_RUN_SETUP: "OFF" }), "off");
	assert.equal(setupMode({ PI_BG_RUN_SETUP: "whatever" }), "prompt");
});

test("decide: off and an explicit cacheWarming opt-out are never touched", () => {
	assert.equal(decide("idle", { setup: "prompt", interactive: true }).action, "skip");
	assert.equal(decide("off", { setup: "auto", interactive: true }).action, "skip");
	assert.equal(decide("streaming", { setup: "off", interactive: true }).action, "skip");
	// Interactive asks; everything else adjusts silently.
	assert.equal(decide("streaming", { setup: "prompt", interactive: true }).action, "prompt");
	assert.equal(decide(undefined, { setup: "prompt", interactive: true }).action, "prompt");
	assert.equal(decide("streaming", { setup: "prompt", interactive: false }).action, "set");
	assert.equal(decide(undefined, { setup: "auto", interactive: true }).action, "set");
});

test("a piped install adjusts the setting silently and preserves the rest of the file", () => {
	const dir = settingsDir();
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify({ defaultModel: "x", cacheWarming: "streaming" }, null, 2));
	const out = runSetup(dir);
	assert.match(out, /set "cacheWarming": "idle"/);
	const settings = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(settings.cacheWarming, "idle");
	assert.equal(settings.defaultModel, "x");
	// Re-running (pi update reconciles installs) is a no-op.
	const again = runSetup(dir);
	assert.match(again, /already "idle"/);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).cacheWarming, "idle");
});

test("an explicit opt-out, PI_BG_RUN_SETUP=off and an unparseable file are left alone", () => {
	const dir = settingsDir();
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify({ cacheWarming: "off" }));
	assert.match(runSetup(dir), /stays "off"/);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).cacheWarming, "off");

	writeFileSync(file, JSON.stringify({ cacheWarming: "streaming" }));
	assert.match(runSetup(dir, { PI_BG_RUN_SETUP: "off" }), /PI_BG_RUN_SETUP=off/);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).cacheWarming, "streaming");

	writeFileSync(file, "{ not json");
	assert.match(runSetup(dir), /could not parse/);
	assert.equal(readFileSync(file, "utf8"), "{ not json");
});

test("a machine without pi settings gets no settings file", () => {
	const dir = settingsDir();
	assert.match(runSetup(dir), /no pi settings/);
	assert.equal(existsSync(join(dir, "settings.json")), false);
});
