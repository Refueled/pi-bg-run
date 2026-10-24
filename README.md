# pi-bg-run

A Pi extension that runs the model's shell commands as detached background
tasks, on **Windows (native Pi with Git Bash)** and POSIX. A `bg_run` call
starts the command detached, returns a task id at once, and wakes the agent
with one completion message when the command exits — so a 10-minute docker or
test run never holds up the conversation.

```text
agent> bg_run { "command": "docker run ... pytest ...", "timeoutSeconds": 440 }
       → task bg-1 started, log: C:\Users\you\.pi-bg-run\<session>\bg-1.log
   ... the agent does other work, or idles ...
       ← "Background task bg-1 finished: exited (code 0), ran 4m 10s. ..."
```

## Install

```bash
pi install git:github.com/Refueled/pi-bg-run
```

Then run `/reload` in Pi or restart it. There is no build step and no npm
publish — the GitHub repository is the distribution — and Pi supplies the
`typebox` and `@earendil-works/pi-coding-agent` imports. `pi remove
git:github.com/Refueled/pi-bg-run` uninstalls it.

Requires Git Bash on Windows (Pi's own `bash` environment), like Pi's `bash`
tool. Set `PI_BG_RUN_SHELL` to override the shell.

For development, point Pi at a checkout (`pi install ./pi-bg-run`, loaded in
place) or copy this directory to `~/.pi/agent/extensions/pi-bg-run`.

## What it adds

- `bg_run(command, cwd?, timeoutSeconds?, label?, herdr?)` — run a command as a
  detached background task and return its id at once. `timeoutSeconds` bounds
  the task: at the deadline its process tree is killed and the state becomes
  `killed (timed out)`. Inside Herdr the task runs **visibly in a new tab**
  named for the task (see below); `herdr: "pane"` splits the current tab and
  `herdr: "none"` runs detached.
- `bg_output(task_id, latest?, filter?)` — read a task's output from where the
  last read stopped, or only the newest output with `latest: true`, optionally
  keeping only lines matching a regex. Safe to call at any time while the task
  runs, so an agent that wants to watch progress can poke at it. Each call also
  reports the task's state and how many log bytes remain unread.
- `bg_tasks()` — every task of this session with state (`running`, `exited`,
  `killed`, `exit unknown`), runtime and exit code or kill reason.
- `bg_kill(task_id)` — stop the task and its whole process tree.
- `/bg` — list the tasks in the TUI; pick one to see its output or kill it.

When a task ends, one completion message (exit status, runtime, last output)
is delivered as a steering message: a busy agent gets it at the next turn
boundary and an idle agent gets a new turn, so there is no need to sleep or
poll to wait for a task.

Tasks belong to the session that started them. Quitting or switching sessions
kills what is still running; `/reload` keeps tasks. Logs live under
`~/.pi-bg-run/<session-id>/` (override the root with `PI_BG_RUN_STATE`) and are
removed after 7 days. A task whose log passes 100 MiB is stopped with
`killed (log limit passed)`.

## Herdr tabs

When Pi runs inside Herdr (`HERDR_ENV=1`), `bg_run` starts the task in a new
Herdr tab whose label is the task's, running the same wrapper with its output
`tee`'d to the task log: the pane shows the output live and `bg_output` works
exactly as in detached mode. The lifecycle:

- the tab **closes itself when the task succeeds** (exit code 0);
- a task that **fails keeps its tab**, with the pane renamed to
  `bg-N failed: exited (code 1)` for inspection;
- `bg_kill`, a timeout, or session shutdown **closes the tab**, which tears
  down its terminal and kills the process tree (verified; `taskkill` is the
  fallback). The log keeps the output either way.

`herdr pane run` only acknowledges that a command line was queued, so the
extension first types a throwaway `echo` probe and waits for it to appear —
the pane's shell is at its prompt when it answers. The typed line is quoted
for the pane's own shell (PowerShell, cmd or POSIX). If Herdr cannot take the
task, it runs detached instead.

## How it works

Each task is a generated wrapper script run by Git Bash (or `bash`), spawned
detached with its output redirected to the task's own log by the script itself
(file handles cannot be passed through the spawn to Git Bash reliably on
Windows). The command text travels inside a nonce-delimited heredoc, so quotes,
`#`, `$` and heredocs reach the shell as written. When the command exits the
wrapper appends `__BG_EXIT__:<nonce>:<code>`; the extension polls the log,
reads that marker, and sends the completion. The nonce is random per task, so
output that looks like a marker is not one. A small detached watcher
(`src/bg-watcher.cjs`) kills the task's tree if Pi crashes first.

Windows has no POSIX signals for console process trees: `bg_kill` and the
watcher use `taskkill /PID <pid> /T /F` (immediate, no TERM grace). A process
that deliberately escapes its parent tree before being killed can survive it —
a killed `docker run` task in particular may leave its container running; check
with `docker ps` when that matters. A `;`-chained command's reported exit code
is the last command's; put per-stage codes in files or end the chain with
`exit $(cat ...)`.

The task registry lives on `globalThis`, so `/reload` keeps running tasks and
the next runtime continues reporting them.

## Development

```sh
node --test test/*.test.ts   # unit tests: marker protocol, output paging, lifecycle
node scripts/spike.ts        # real-process smoke check, no Pi needed
```

Design follows [pi-bg-bash](https://github.com/gvanderclay/pi-bg-bash) —
the exit-marker protocol, the registry on `globalThis`, and
completion-as-steering-message — with its process port replaced by a
Windows-capable one; see `THIRD-PARTY-NOTICES.md` for its MIT notice.
`PLAN.md` records the plan and phase status.
