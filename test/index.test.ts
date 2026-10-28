// The wiring in `src/index.ts` against a stand-in ExtensionAPI: the registered
// handlers, the warm host built from the session context, and the tool names.
// Skipped where the `typebox` peer dependency is not installed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getRegistry, type Task } from "../src/registry.ts";

process.env.PI_BG_RUN_STATE = mkdtempSync(join(tmpdir(), "pi-bg-run-index-"));

type Handler = (event: unknown, ctx: unknown) => unknown;
type Factory = (pi: unknown) => void;

let factory: Factory | undefined;
try {
	factory = (await import("../src/index.ts")).default as Factory;
} catch {
	// the peer dependencies are not installed; the wiring is covered where they are
}

function fakePi(settings: { cacheWarming?: string } = {}) {
	const handlers: Record<string, Handler[]> = {};
	const tools: string[] = [];
	const pi = {
		on: (name: string, handler: Handler) => {
			(handlers[name] ??= []).push(handler);
		},
		registerTool: (tool: { name: string }) => {
			tools.push(tool.name);
		},
		registerCommand: () => undefined,
		getSettings: () => ({ cacheWarming: settings.cacheWarming }),
		sendMessage: () => undefined,
	};
	return { pi, handlers, tools };
}

function fakeCtx(sessionId: string, model: { promptCache?: { short?: number; long?: number } } | undefined = { promptCache: { short: 300 } }) {
	const status: { key: string; text: string | undefined }[] = [];
	const notices: string[] = [];
	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				status.push({ key, text });
			},
			notify: (message: string) => {
				notices.push(message);
			},
		},
		isIdle: () => true,
		model,
	};
	return { ctx, status, notices };
}

function makeTask(id: string): Task {
	return {
		id,
		command: `command ${id}`,
		cwd: ".",
		logPath: "x.log",
		scriptPath: "x.sh",
		pid: 1,
		nonce: "n",
		scanFrom: 0,
		startedAt: Date.now(),
		state: "running",
		readPosition: 0,
		notified: false,
	};
}

test("index registers the lifecycle, cache-warming and settled handlers and the tools", { skip: factory === undefined }, () => {
	const { pi, handlers, tools } = fakePi();
	factory?.(pi);
	for (const name of ["session_start", "session_shutdown", "cache_warming_decision", "agent_settled"]) {
		assert.ok((handlers[name]?.length ?? 0) > 0, `no handler for ${name}`);
	}
	assert.deepEqual(tools.sort(), ["bg_kill", "bg_output", "bg_run", "bg_tasks"]);
});

test("the decision handler warms the cache only while a task runs", { skip: factory === undefined }, async () => {
	const { pi, handlers } = fakePi();
	factory?.(pi);
	const { ctx } = fakeCtx("wiring-session");
	await handlers.session_start[0](undefined, ctx);
	const decide = handlers.cache_warming_decision[0];
	assert.deepEqual(decide(undefined, undefined), {});
	const task = makeTask("bg-1");
	getRegistry().tasks.set(task.id, task);
	assert.deepEqual(decide(undefined, undefined), { action: "warm" });
	getRegistry().tasks.clear();
	assert.deepEqual(decide(undefined, undefined), {});
	await handlers.session_shutdown[0](undefined, undefined);
});

test("the settled handler warns once when the cache cannot be kept warm", { skip: factory === undefined }, async () => {
	const { pi, handlers } = fakePi({ cacheWarming: "streaming" });
	factory?.(pi);
	const { ctx, notices } = fakeCtx("wiring-warn-session");
	await handlers.session_start[0](undefined, ctx);
	const task = makeTask("bg-2");
	getRegistry().tasks.set(task.id, task);
	await handlers.agent_settled[0](undefined, undefined);
	await handlers.agent_settled[0](undefined, undefined);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /cache warming unavailable/);
	await handlers.session_shutdown[0](undefined, undefined);
});
