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

- `bg_run(command, cwd?, timeoutSeconds?, label?, herdr?, keepOpen?)` — run a
  command as a detached background task and return its id at once.
  `timeoutSeconds` bounds the task: at the deadline its process tree is killed
  and the state becomes `killed (timed out)`. Inside Herdr the task runs
  **visibly in a new tab** named for the task (see below); `herdr: "pane"`
  splits the current tab and `herdr: "none"` runs detached.
- `bg_output(task_id, latest?, filter?)` — read a task's output from where the
  last read stopped, or only the newest output with `latest: true`, optionally
  keeping only lines matching a regex. Safe to call at any time while the task
  runs, so an agent that wants to watch progress can poke at it. Each call also
  reports the task's state and how many log bytes remain unread.
- `bg_tasks(limit?)` — this session's tasks with state (`running`, `exited`,
  `killed`, `exit unknown`), runtime and exit code or kill reason. Running
  tasks first, then the most recent; at most `limit` (default 15) are listed,
  and older ones still answer to `bg_output` and `bg_kill` by id.
- `bg_kill(task_id)` — stop the task and its whole process tree.
- `/bg` — list the tasks in the TUI; pick one to see its output or kill it.
- **Cache warming** — while a task runs, the provider's prompt cache is kept
  warm so the completion turn does not pay a cache miss after a long idle
  wait (see below).

When a task ends, one completion message (exit status, runtime, last output)
is delivered as a steering message: a busy agent gets it at the next turn
boundary and an idle agent gets a new turn, so there is no need to sleep or
poll to wait for a task.

Tasks belong to the session (conversation) that started them. Quitting or
switching sessions kills what is still running and forgets its tasks — the next
session's list starts empty, ids from `bg-1` — so one conversation's tasks never
show up in another's. `/reload` keeps tasks. Logs live under
`~/.pi-bg-run/<session-id>/` (override the root with `PI_BG_RUN_STATE`) and are
removed after 7 days. A task whose log passes 100 MiB is stopped with
`killed (log limit passed)`.

## Herdr tabs

When Pi runs inside Herdr (`HERDR_ENV=1`), `bg_run` starts the task in a new
Herdr tab whose label is the task's, running the same wrapper with its output
`tee`'d to the task log: the pane shows the output live and `bg_output` works
exactly as in detached mode. The lifecycle:

- the tab **closes itself when the task ends**, whatever the outcome: the
  output lives on in the log and the completion message, so nothing piles up;
- `keepOpen: true` is the one exception: a task that **fails keeps its tab**,
  with the pane renamed to `bg-N failed: exited (code 1)` for inspection;
- `bg_kill`, a timeout, or session shutdown **closes the tab**, which tears
  down its terminal and kills the process tree (verified; `taskkill` is the
  fallback). The log keeps the output either way.

`herdr pane run` only acknowledges that a command line was queued, so the
extension first types a throwaway `echo` probe and waits for it to appear —
the pane's shell is at its prompt when it answers. The typed line is quoted
for the pane's own shell (PowerShell, cmd or POSIX). If Herdr cannot take the
task, it runs detached instead.

## Cache warming

An agent that idles while a task runs makes no model calls, and prompt caches
expire on provider TTLs (often five minutes): the completion turn then pays a
full cache miss on the whole conversation. While any task is running, this
extension overrides pi's `cache_warming_decision` to `warm`, so pi re-sends
its last request with a one-token output cap at 90% of the cache lifetime.
The refresh is silent — it never enters model context, does not wake the
agent, and counts only toward session usage totals. (Pi's own economics
assume a 15% chance that a request arrives during an idle wait and usually
decline exactly when an agent waits on a background task; the extension knows
better.)

Two things pi cannot infer must be in place:

- the global setting **`"cacheWarming": "idle"`** in `settings.json` (or the
  settings selector) — the default `"streaming"` stops warming the moment the
  agent settles, which is exactly the wait being protected;
- a **`promptCache` lifetime on the model** — built-in models declare one; for
  a custom or proxied model add it in `models.json`, e.g.
  `{ "modelOverrides": { "mimo-v2.6-pro": { "promptCache": { "short": 300 } } } }`,
  using the conservative end of the provider's published cache TTL.

The first is set up at install time: the package's `postinstall`
(`scripts/ensure-cache-warming.cjs`) checks `<agent-dir>/settings.json` and
asks on an interactive terminal (`[Y/n]`, default yes), adjusting the setting
silently anywhere else — which is what `pi install` itself looks like to a
script, since pi pipes the package manager's stdio. An explicit `"off"` is
always respected; `PI_BG_RUN_SETUP=off` disables the check and
`PI_BG_RUN_SETUP=auto` skips the question. Installs that run no package
scripts (e.g. `--ignore-scripts`) adjust nothing — run
`node scripts/ensure-cache-warming.cjs` by hand, or set the key yourself; the
session warning below is the backstop either way. The setting takes effect in
new pi sessions.

When either is missing the extension says so once per session — and in the
status line — instead of letting the miss happen silently. The footer status
is the heartbeat: while tasks run it reads
`Cache warming on: bg task bg-89 is still running (4m 43s), standby.`,
refreshed every `PI_BG_RUN_HEARTBEAT_S` seconds (default 100; `0` or `off`
disables it). There are deliberately no model-facing heartbeat messages: each
would be a full turn — the whole prefix re-read, plus two messages appended to
the transcript per beat — to do what one silent replay already does.
`"showCacheMissNotices": true` additionally shows pi's own notices for
every successful warm refresh.

Limits to know: pi stops idle warming 30 minutes after the last real request,
so a wait longer than that loses the warm cache before the completion turn
(`PI_CACHE_RETENTION=long` selects the one-hour cache tier where the provider
supports it). `/session` shows the next warming decision and its economics.

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
node scripts/ensure-cache-warming.cjs  # apply the cache-warming setting by hand
```

Design follows [pi-bg-bash](https://github.com/gvanderclay/pi-bg-bash) —
the exit-marker protocol, the registry on `globalThis`, and
completion-as-steering-message — with its process port replaced by a
Windows-capable one; see `THIRD-PARTY-NOTICES.md` for its MIT notice.
`PLAN.md` records the plan and phase status.
