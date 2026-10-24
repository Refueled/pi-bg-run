// `pi-bg-run`: background tasks for the model's shell commands, on Windows and
// POSIX. A `bg_run` call starts the command detached, logs it under
// `~/.pi-bg-run/<session-id>/`, and returns a task id at once. When the command
// exits the agent gets one completion message, which starts a turn if the
// agent is idle. `bg_output` reads a task's output at any time, `bg_tasks`
// lists the tasks, `bg_kill` stops one, and `/bg` shows the list.
//
// The task registry lives on `globalThis`, so `/reload` keeps tasks and the
// tools can inspect them from the next runtime.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { killTask, attach, endSession, getRegistry, startTask, type Task } from "./registry.ts";
import { oneLine, stateData, stateText, taskData, taskLine, type PiLike } from "./notify.ts";
import { readOutput, taskTail } from "./output.ts";

/** What the model is told when a task starts. */
const COMPLETION_TEXT =
	"When the task ends, one message with its exit status and last output arrives and starts a turn if you are idle, " +
	"so do not sleep or poll to wait for it. Inspect a running task at any time with `bg_output` (its newest output " +
	"with `latest: true`) and `bg_tasks`.";

const STATE_FIELDS = {
	task_id: Type.String(),
	state: Type.Union([
		Type.Literal("running"),
		Type.Literal("exited"),
		Type.Literal("killed"),
		Type.Literal("exit-unknown"),
	]),
	exit_code: Type.Optional(Type.Number({ description: "Set when state is exited" })),
	reason: Type.Optional(
		Type.Union(
			[
				Type.Literal("killed by agent"),
				Type.Literal("killed by user"),
				Type.Literal("timed out"),
				Type.Literal("log limit passed"),
			],
			{ description: "Set when state is killed" },
		),
	),
};
const TASK_FIELDS = {
	...STATE_FIELDS,
	command: Type.String(),
	label: Type.Optional(Type.String()),
	started_at_ms: Type.Number({ description: "Epoch milliseconds" }),
	ended_at_ms: Type.Optional(Type.Number({ description: "Epoch milliseconds; absent while running" })),
	runtime_ms: Type.Number(),
};

function taskOrThrow(id: string): Task {
	const task = getRegistry().tasks.get(id);
	if (task === undefined) throw new Error(`Unknown task id: ${id}. \`bg_tasks\` lists this session's tasks.`);
	return task;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		let sessionId = "no-session";
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			// a session without an id still gets a log directory
		}
		attach(pi as unknown as PiLike, sessionId, ctx.cwd);
	});
	pi.on("session_shutdown", async () => {
		endSession();
	});

	pi.registerTool({
		name: "bg_run",
		label: "bg_run",
		description:
			"Run a shell command as a detached background task and return its task id at once, without waiting for it. " +
			"Use it for anything expected to run longer than a couple of minutes (builds, test runs, docker runs, downloads) " +
			"when you have other work to do, or nothing to do until it ends. " +
			`The command runs in the same shell as \`bash\`; ${COMPLETION_TEXT} ` +
			"Inside Herdr the task runs visibly in a tab (or a split with `herdr: \"pane\"`); " +
			"the tab closes when the task succeeds and stays open, renamed, when it fails. " +
			"`timeoutSeconds` bounds the task: at the deadline its process tree is killed and the state becomes " +
			"killed (timed out). Write long output to a file in the command if a log artifact is wanted; " +
			"`bg_output` reads the captured output regardless.",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run in the background" }),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session's" })),
			timeoutSeconds: Type.Optional(
				Type.Number({ description: "Kill the task's process tree at this many seconds; state becomes killed (timed out)" }),
			),
			label: Type.Optional(Type.String({ description: "Short name for this task, shown in bg_tasks and /bg" })),
			herdr: Type.Optional(
				Type.Union([Type.Literal("tab"), Type.Literal("pane"), Type.Literal("none")], {
					description:
						"Run visibly in Herdr: 'tab' (the default inside Herdr) makes a new tab named for the task, " +
						"'pane' splits the current tab, 'none' runs detached.",
				}),
			),
		}),
		outputSchema: Type.Object({
			...STATE_FIELDS,
			command: Type.String(),
			cwd: Type.String(),
			log_path: Type.String(),
			started_at_ms: Type.Number(),
			tab_id: Type.Optional(Type.String({ description: "Set when the task runs in a Herdr tab" })),
			pane_id: Type.Optional(Type.String({ description: "Set when the task runs in a Herdr pane" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(_toolCallId, params) {
			const task = await startTask(params);
			const inHerdr = task.herdr === undefined ? "" : `\nHerdr: ${task.herdr.tabId ?? task.herdr.paneId}`;
			return {
				structuredContent: {
					task_id: task.id,
					state: "running",
					command: task.command,
					cwd: task.cwd,
					log_path: task.logPath,
					started_at_ms: task.startedAt,
					...(task.herdr?.tabId === undefined ? {} : { tab_id: task.herdr.tabId }),
					...(task.herdr === undefined ? {} : { pane_id: task.herdr.paneId }),
				},
				content: [
					{
						type: "text" as const,
						text: `Started background task ${task.id}: ${oneLine(task.command)}${inHerdr}\nLog: ${task.logPath}\n${COMPLETION_TEXT}`,
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "bg_output",
		label: "bg_output",
		description:
			"Read the output of a background task from where you last stopped, capped in size. " +
			"Each call returns only output you have not read yet and says how much remains. " +
			"`latest: true` skips to the newest output, for a quick look at what a running task is doing. " +
			"`filter` is a regex that keeps only matching lines. The result also says whether the task is running. " +
			"Safe to call at any time while the task runs; to wait for its end, rely on the completion message instead of polling.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The task id returned by bg_run" }),
			latest: Type.Optional(Type.Boolean({ description: "Skip to the end of the log and return the newest output" })),
			filter: Type.Optional(Type.String({ description: "Regex; return only the matching lines of the output read" })),
		}),
		outputSchema: Type.Object({
			...STATE_FIELDS,
			output: Type.String({ description: "The output this call returned, after `filter`" }),
			truncated: Type.Boolean({ description: "More output remains unread, or `latest` skipped some" }),
			unread_bytes: Type.Number({
				description: "Log bytes not yet read; the task is done when state is not running and this is 0",
			}),
		}),
		// Not read-only: each call moves the task's read position.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params) {
			const task = taskOrThrow(params.task_id);
			const read = readOutput(task, params);
			return { structuredContent: read.data, content: [{ type: "text" as const, text: read.text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "bg_tasks",
		label: "bg_tasks",
		description:
			"List every background task of this session with its id, command, state, runtime, " +
			"and exit code or reason. States: running, exited, killed, exit unknown.",
		parameters: Type.Object({}),
		outputSchema: Type.Object({ tasks: Type.Array(Type.Object(TASK_FIELDS)) }),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute() {
			const tasks = [...getRegistry().tasks.values()];
			const text = tasks.length === 0 ? "No background tasks." : tasks.map(taskLine).join("\n");
			return {
				structuredContent: { tasks: tasks.map(taskData) },
				content: [{ type: "text" as const, text }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "bg_kill",
		description:
			"Stop a background task and its whole process tree. The task's state becomes " +
			"`killed (killed by agent)` and a completion message arrives like a normal end.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The task id returned by bg_run" }),
		}),
		outputSchema: Type.Object(STATE_FIELDS),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params) {
			const task = taskOrThrow(params.task_id);
			killTask(task, "killed by agent");
			return {
				structuredContent: { task_id: task.id, ...stateData(task) },
				content: [{ type: "text" as const, text: `Task ${task.id}: ${stateText(task)}.` }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("bg", {
		description: "List the background tasks; pick one to see its output or kill it",
		handler: async (_name, ctx: ExtensionCommandContext) => {
			await bgCommand(ctx);
		},
	});
}

/** `/bg`: the tasks as a list; picking one shows its output or kills it after a confirm. */
async function bgCommand(ctx: ExtensionCommandContext): Promise<void> {
	const tasks = [...getRegistry().tasks.values()].sort(
		(a, b) => Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt,
	);
	if (tasks.length === 0) return ctx.ui.notify("No background tasks.", "info");
	if (!ctx.hasUI) return ctx.ui.notify(tasks.map(taskLine).join("\n"), "info");
	const lines = tasks.map(taskLine);
	const pick = await ctx.ui.select("Background tasks", lines);
	if (pick === undefined) return;
	const task = tasks[lines.indexOf(pick)];
	if (task === undefined) return;
	const action = await ctx.ui.select(`Task ${task.id}`, ["Show output", "Kill task", "Cancel"]);
	if (action === "Show output") {
		const tail = taskTail(task, 40, 8192);
		await ctx.ui.notify(tail.text === "" ? "(no output)" : tail.text, "info");
	} else if (action === "Kill task") {
		if (await ctx.ui.confirm(`Kill ${task.id}?`, oneLine(task.command))) killTask(task, "killed by agent");
	}
}
