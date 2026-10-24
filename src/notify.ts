// The completion message and the one wording of a task's state, shared by the
// tools, `/bg` and the completion message. A completion is sent as a steering
// message: a busy agent gets it when its current turn ends, and it starts a
// turn when the agent is idle.
import { taskTail } from "./output.ts";
import type { Task, TaskState } from "./registry.ts";

export const MESSAGE_TYPE = "pi-bg-run";

/** The little surface of Pi this module needs; the tests pass a stand-in. */
export type PiLike = {
	sendMessage(
		message: { customType: string; content: string; display?: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
};

/** `1.2s`, or `2m 5s` from a minute on. */
export function formatRuntime(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/** How long the task has run, or ran: frozen at its end. */
export function runtimeText(task: Task): string {
	return formatRuntime((task.endedAt ?? Date.now()) - task.startedAt);
}

/** A command on one line (newlines shown as ⏎), cut to 200 characters. */
export function oneLine(command: string): string {
	const line = command.replace(/\s*\n\s*/g, " ⏎ ");
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * The one wording of a task's state: `running`, `exited (code 0)`,
 * `killed (timed out)`, `exit unknown`.
 */
export function stateText(task: Task): string {
	if (task.state === "killed") return `killed (${task.reason})`;
	if (task.state === "exited") return `exited (code ${task.exitCode})`;
	if (task.state === "running") return "running";
	return "exit unknown";
}

export type TaskData = {
	task_id: string;
	command: string;
	label?: string;
	state: TaskState;
	exit_code?: number;
	reason?: string;
	started_at_ms: number;
	ended_at_ms?: number;
	runtime_ms: number;
};

/** `stateText` as data for structured results: `exit_code` only when exited, `reason` only when killed. */
export function stateData(task: Task): { state: TaskState; exit_code?: number; reason?: string } {
	if (task.state === "killed") return { state: "killed", reason: task.reason };
	if (task.state === "exited") return { state: "exited", exit_code: task.exitCode };
	return { state: task.state };
}

/** One task as data for `bg_tasks`, with the full command. */
export function taskData(task: Task): TaskData {
	return {
		task_id: task.id,
		command: task.command,
		...(task.label === undefined ? {} : { label: task.label }),
		...stateData(task),
		started_at_ms: task.startedAt,
		...(task.endedAt === undefined ? {} : { ended_at_ms: task.endedAt }),
		runtime_ms: (task.endedAt ?? Date.now()) - task.startedAt,
	};
}

/** One line per task for `bg_tasks` and `/bg`: `id | state | runtime | command`. */
export function taskLine(task: Task): string {
	const label = task.label === undefined ? "" : `${task.label}: `;
	return `${task.id} | ${stateText(task)} | ${runtimeText(task)} | ${label}${oneLine(task.command)}`;
}

/** The completion text: id, command, state, runtime and the output's last lines. */
export function completionText(task: Task): string {
	const { text: tail, cut } = taskTail(task);
	const label = cut
		? `Last output, cut to the last lines; \`bg_output ${task.id}\` reads it all:`
		: "Last output:";
	return [
		`Background task ${task.id} finished: ${stateText(task)}, ran ${runtimeText(task)}.`,
		`Command: ${oneLine(task.command)}`,
		tail === "" ? "(no output)" : `${label}\n${tail}`,
	].join("\n");
}

/** Send the completion: one message per task, once. */
export function sendCompletion(pi: PiLike, task: Task): void {
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: completionText(task),
			display: true,
			details: { id: task.id, ...stateData(task) },
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
}
