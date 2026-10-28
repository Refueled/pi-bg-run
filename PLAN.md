# pi-bg-run — background task runner extension for Pi (Windows-first)

Status: phases 1–3 complete (2026-06-07): core runner, tools and the Herdr
tab layer are implemented, tested (31/31) and accepted live. Phase 4
(bash-tool replacement, upstream offer) is optional and not started.
Owner decisions recorded in section 6.
Work directory created 2026-06-07 for this extension's development.

Progress notes:
- 22/22 unit tests pass (`node --test test/*.test.ts`); real-process spike
  (`node scripts/spike.ts`) settles a task from its exit marker and fires the
  completion message; a headless Pi run with the extension reported
  `COMPLETION-SEEN exited (code 0)` from a real `bg_run` completion message.
- Windows finding: **Git Bash cannot take a file handle through a spawn's
  stdio** (bash exits 1 silently when stdout/stderr are file descriptors).
  The wrapper script therefore redirects its own output (`exec >>"$1" 2>&1`),
  which works detached on Windows and POSIX alike.
- Installed globally at `~/.pi/agent/extensions/pi-bg-run/`; loads through
  extension discovery (verified headless). `/reload` activates it in a running
  session.
- Ids restart at `bg-1` per session and skip ids whose log already exists.
- **Post-pilot updates (after live use):** (1) the close-on-success tab policy
  piled up failed tabs and agents closed them by hand — a tab now closes on
  **any** end, with `keepOpen` opting back into keeping a failed one renamed;
  (2) the task list grew across conversations (the registry is per Pi process)
  — a session change now kills and forgets the old session's tasks (ids and
  `bg_tasks` start fresh), and `bg_tasks` lists at most `limit` (default 15),
  running first, then the most recent.
- **Cache warming mode (2026-10-25):** while a task runs, the extension
  overrides pi's `cache_warming_decision` to `warm`, keeping the prompt cache
  alive through pi's native silent refresh (one-token replay at 90% of the
  cache TTL, never in model context, usage-only in session totals). A footer
  status line is the heartbeat (`PI_BG_RUN_HEARTBEAT_S`, default 100 s).
  Requires the global `cacheWarming: "idle"` setting and a `promptCache`
  lifetime on the model (pi's own economics assume a 15% idle-continuation
  chance and otherwise decline exactly when an agent waits on a task); both
  gaps are diagnosed in the status line and one warning per session. Pi's
  30-minute idle horizon bounds waits longer than that. Model-facing
  heartbeat turns were rejected: each is a full priced turn that appends two
  messages to the transcript to do what one silent replay already does.
  Install-time setup: the package `postinstall`
  (`scripts/ensure-cache-warming.cjs`) sets `cacheWarming: "idle"` in
  `<agent-dir>/settings.json` at `pi install`/`pi update` — asking on an
  interactive terminal, silent under pi's piped stdio (verified: pi's git
  install runs `npm install` in the checkout without `--ignore-scripts`, and
  the root `postinstall` fires), respecting an explicit `"off"`, with
  `PI_BG_RUN_SETUP=off|auto|prompt` to force a behavior.

## 1. Request understanding

Build a **global Pi extension** (loads in every session from the personal
extension area, not project-scoped) that lets the agent **run long shell tasks
in the background** instead of blocking the conversation for the whole tool
call. Concretely, for a task like a long containerized test pipeline followed
by a link probe, each stage writing its own log and `.exit` file:

```sh
docker run ... pytest ... > tmp/tests.log 2>&1; printf '%s\n' "$?" > tmp/tests.exit
python probe_tool.py ... > tmp/probe.log 2>&1; printf '%s\n' "$?" > tmp/probe.exit   (timeout 440s)
```

today the `bash` tool call holds the turn until exit or the 440 s timeout.
Wanted behavior: the call returns immediately with a task id, output is
captured to a log the agent can read at any time, the exit status is recorded,
and when the task finishes the agent is **woken with a completion message**
(starting a new turn if it was idle). The task is killable and can carry a
timeout. Optionally, since Pi runs inside **Herdr**, the task should be
visible in a Herdr pane/tab that closes on completion.

Target: native Windows Pi (Git Bash command environment). Design stays
cross-platform where it is free.

## 2. Findings from research

### Pi extension API (pi 1.4.0)
- Global TypeScript extensions live in `~/.pi/agent/extensions/` (or a pi
  package installed with `pi install`); no build step (jiti). Factory gets
  `ExtensionAPI`: `registerTool`, `registerCommand`, `pi.on(...)`,
  `pi.sendMessage(msg, { triggerTurn: true })` to wake the agent from an idle
  state — that is the completion-notification primitive.
- Tools return `{ content, details }`; annotate with
  `readOnlyHint`/`destructiveHint`/`idempotentHint` for permission extensions.
  `ctx.mode` must be respected (keep behavior rendering-independent).
- Reference examples: `examples/extensions/tools.ts`, `bash-spawn-hook.ts`,
  `notify.ts`, `todo.ts`.

### pi-bg-bash (github.com/gvanderclay/pi-bg-bash, MIT, npm `pi-bg-bash`)
Does exactly this on macOS/Linux: replaces `bash` with the same tool plus a
`background` flag; detached `sh` wrapper writes output to
`$XDG_STATE_HOME/pi-bg/<session>/bg-N.log` and appends a nonce-marked
`__PI_BG_EXIT__:<nonce>:<code>` line; a separate watcher process kills the
task's process group if Pi dies; `bash_output` / `bash_tasks` / `bash_kill`
tools; `/bg` picker; completion message wakes the agent; log limits (100 MiB),
gzip after completion, 7-day cleanup, auto-promotion of >120 s foreground
commands (`ctrl+shift+b`).

Why it is POSIX-only is **not** a bash-vs-pwsh problem: Pi on native Windows
already runs `bash` via Git Bash (`%ProgramFiles%\Git\bin\bash.exe`, resolved
via `getShellConfig`). The blockers are:
- `process.kill(-pid, sig)` process-group signalling and `kill -s 0 -- -grp`
  group liveness (no POSIX signals for Windows console trees),
- the POSIX `sh` wrapper text (fd juggling, `exec 3>&2`),
- TERM→grace→KILL escalation (Windows has no SIGTERM for console trees),
- XDG log paths (trivial).

Its `ProcessPort` interface (`launch`, `signalGroup`, `groupAlive`,
`pidAlive`) is precisely the seam a Windows implementation replaces. Being
MIT, the design and code can be ported with attribution.

### Herdr (0.9.5, installed here) — the user's "new tab" idea is directly supported
`herdr tab create|close`, `herdr pane split|run|wait-output|read|close|process-info`,
JSON over the session socket; `HERDR_ENV=1` marks a process running inside
Herdr. `herdr pane wait-output --regex ... --timeout <ms>` blocks until output
matches, which pairs with a nonce exit marker exactly like pi-bg-bash's.

### Pi 1.4.0 exports `getShellConfig` / `getShellEnv`
The extension can run tasks in the same shell and environment Pi's own `bash`
tool uses (Git Bash here), including the session variables
(`PI_SESSION_ID`, `PI_MODEL`, ...).

## 3. Architecture (recommended)

One extension, two layers. Layer 1 is the product; layer 2 is an optional
visibility mode.

### Layer 1 — detached task runner (core, works outside Herdr too)
- **Tool surface** (separate tools; do not replace `bash`):
  - `bg_run(command, cwd?, timeoutSeconds?, label?, herdr?, keepOpen?) -> {
    task_id, log_path }` — returns immediately. `herdr: "pane" | "tab"` opts
    into layer 2; default from a setting when `HERDR_ENV=1`. `keepOpen` keeps
    a failed Herdr tab on screen instead of closing it.
  - `bg_output(task_id, latest?, filter?)` — read the log incrementally from
    where the last read stopped, or only the newest tail with `latest: true`,
    optionally filtered by a regex. Read-only and cheap: the **inspection
    surface for an agent that stays awake and pokes at running tasks** (e.g.
    while subagent workers run). Works identically for Herdr-mode tasks (see
    layer 2: output is teed to the same log).
  - `bg_tasks(limit?)` — the session's tasks with state (`running`, `exited
    (code N)`, `killed (timed out)`, `killed`, `orphaned`), runtime,
    last-activity
    timestamp and log size. Together with `bg_output` this answers "is it
    still running and what is it doing now" in one call; both tool
    descriptions tell the model it may inspect running tasks at any time,
    without waiting for the completion message.
  - `bg_kill(task_id)` — kill the whole tree.
  - `/bg` — picker list in the TUI (enter = show output, x = kill).
  - Footer/status indicator `bg: n` while tasks run (guarded with
    `ctx.mode === "tui"`).
- **Completion**: when a task exits, `pi.sendMessage(..., { triggerTurn: true })`
  with task id, exit code, duration and the last ~40 lines of output. An idle
  agent gets a new turn; a busy agent sees it at the next boundary.
- **Execution (Windows)**:
  - Spawn Git Bash (`getShellConfig()`, falling back to Pi's documented
    resolution order) `detached: true, windowsHide: true`, stdout/stderr to
    `bg-N.log`; wrapper appends `__BG_EXIT__:<nonce>:<code>` when the command
    exits (nonce per task, so output cannot forge the marker).
  - Wrapper choice: upstream's POSIX `sh` wrapper text under Git Bash `sh.exe`
    for parity (phase-1 spike verifies MSYS pid behavior); if that misbehaves,
    a small Node `bg-runner.cjs` spawned detached that spawns the shell child —
    same marker protocol, easier to test.
  - **Kill/timeout**: `taskkill /PID <pid> /T /F` (whole tree); no TERM grace
    on Windows, documented. `timeoutSeconds` enforces the `timeout 440s`
    semantics: kill at deadline, state `killed (timed out)`.
  - **Crash watch**: a detached watcher checks the Pi pid
    (`process.kill(pid, 0)` works for existence on Windows) and `taskkill /T /F`
    the runner tree when Pi is gone. Cleanup of stale tasks/logs at
    `session_start` via `owner.pid` markers is the backstop (fail open).
  - **Logs**: `%USERPROFILE%\.pi-bg\<session-id>\bg-N.log` (fallback
    `LOCALAPPDATA`), size limit with kill, gzip after completion, 7-day
    cleanup — ported from upstream.

### Layer 2 — Herdr visibility (opt-in per task or setting)
Gate on `HERDR_ENV=1` and `herdr` on PATH; silently fall back to layer 1.
- **Default: a new tab per task** (owner preference; verified equal in
  difficulty to a split): `herdr tab create --label "<task label>" --cwd
  "<cwd>" --no-focus`, then run in `.result.root_pane` returned by the same
  response. `herdr pane split --current --direction right --cwd "$PWD"
  --no-focus` remains the `herdr: "pane"` option.
- Run in the pane: `herdr pane run <pane> -- bash -lc '<command> 2>&1 | tee
  "<log>"; code=${PIPESTATUS[0]}; printf "\n__BG_EXIT__:%s:%s\n" "<nonce>"
  "$code"'` — the task is genuinely visible and interruptible in the tab, and
  `tee` mirrors the full output into the task's log so `bg_tasks`/`bg_output`
  behave the same as detached mode (including after the tab is closed).
  The marker is printed after the pipeline so `wait-output` matches it.
- Completion: the watcher calls `herdr pane wait-output --regex
  '__BG_EXIT__:<nonce>:[0-9]+'` (bounded by the task timeout + margin), then
  `herdr pane read` for the tail, then **closes the pane/tab** whatever the
  outcome — the log and the completion message hold the output, and keeping
  failed tabs open (the original policy) piled them up until agents closed
  them by hand. `keepOpen` leaves a failed one open instead, renamed via
  `herdr pane report-metadata --title ...` so it is clearly the failed task.
- The same completion message is sent either way. If the user closes the tab
  manually mid-run, `process-info`/`wait-output` failure marks the task
  `orphaned` and reports it.
- **Kill**: for Herdr-mode tasks `bg_kill` is `herdr tab close <tab_id>` —
  tearing down the pane's terminal kills its process tree, the same effect as
  taskkill. Phase 3 verifies tree teardown empirically (including children
  detached from the pane's shell); `taskkill /T /F` stays as the fallback for
  anything the terminal teardown leaves behind and for orphan cleanup after a
  Herdr restart.

### Rejected for now
- Replacing the `bash` tool with a `background` flag (pi-bg-bash style):
  valuable, but conflicts with any other bash-replacing extension and with the
  optional `powershell` tool. Phase 4 optional add-on.
- Pure Herdr-only design: breaks headless/print mode and sessions outside
  Herdr; layer 1 must stand alone.

## 4. Repository layout (this work directory)

```
~/.proj/pi-bg-run/
  PLAN.md               this file
  README.md             install + usage
  package.json          pi package: { "pi": { "extensions": ["./src/index.ts"] } }
  src/
    index.ts            factory: registerTool/Command, lifecycle, completion dispatch
    runner.ts           task registry, marker protocol, timeouts
    process-win.ts      ProcessPort: spawn detached, taskkill tree, liveness
    process-posix.ts    upstream port (kept so the extension is cross-platform)
    logs.ts             log dirs, owner markers, limits, gzip, cleanup
    herdr.ts            layer 2: pane/tab lifecycle via the herdr CLI
    notify.ts           completion message / wakeup
  test/                 node --test, fake ProcessPort (port upstream's harness)
```

Installation: `pi install` from this checkout (or symlink/copy into
`~/.pi/agent/extensions/` during development), then `/reload`. Name candidates
(`pi-bg-bash` and `pi-bg-tasks` are taken on npm): **pi-bg-run** (working
title), `pi-bg-cmd`, `pi-bg-win`.

## 5. Phases and acceptance

1. **Skeleton + spike**: extension loads; `bg_run("sleep 20; echo done")`
   returns instantly, log written, exit marker parsed, completion message
   arrives and starts a turn. Decide wrapper (sh text vs Node runner) here.
2. **Core complete**: `bg_output`/`bg_tasks`/`bg_kill`, `/bg`, timeout kill,
   watcher + orphan cleanup, log limits/cleanup. **Acceptance: run the
   motivating docker/pytest + probe pipeline as one `bg_run` with
   `timeoutSeconds: 440`; conversation stays responsive; completion message
   reports the exit codes; the stages' `.log` and `.exit` files match.**
   (Implemented and unit-tested 2026-06-07; live `/bg` TUI check and the
   pipeline acceptance run still to do.)
   - Acceptance PASSED 2026-06-07 (the pipeline as one `bg_run`):
     instant return, conversation free for 5m 47s, completion message arrived
     unprompted (`exited (code 0)`): test stage 379 passed in 197.55s /
     `.exit` 0; probe stage `.exit` 1 (its established value) — both `.exit`
     files match prior-run patterns.
   - Timeout proven precise twice: a 440 s bound killed a task at exactly
     `ran 7m 20s`; the same run is the negative control below.
   - **Findings:** (1) `taskkill /T /F` stopped the wrapper and chain but the
     `docker run` client escaped the tree kill: its container ran to
     completion (508 s) and interleaved late writes into the next run's log.
     A killed/timeout `docker run` task may need a follow-up `docker ps` /
     `docker stop`. (2) A `;`-chained command's reported exit code is the
     last command's: per-stage codes belong in `.exit` files or an `exit
     $(cat ...)` ending. (3) Runs sharing fixed `tmp/*.log` paths interleave
     if an earlier run is not fully dead.
3. **Herdr layer**: tab mode (default) and pane-split mode, auto-close-on-
   success policy, failure retention, manual-close/orphan handling, and
   verification that `herdr tab close` kills the task's process tree.
   Acceptance in a live Herdr session.
   **PASSED 2026-06-07**: success tab auto-closed, failure tab kept with pane
   renamed `bg-2 failed: exited (code 1)`, `bg_kill` closed its tab, output
   captured through `tee` survived tab teardown. `herdr tab close` kills the
   process tree (verified with a sleep process). **Update after live use**:
   failure retention was dropped — failed tabs piled up and agents closed them
   by hand, so every end now closes the tab (`keepOpen` retains the old
   failure behavior per task). Phase-3 findings: (1)
   `herdr pane run` admits text without executing it — a shell-readiness
   `echo` probe + `wait-output` gate is required before typing the real line;
   (2) the typed line must be quoted for the pane's own shell (PowerShell
   `& '...'`, cmd `"..."`, POSIX `'...'`), and the shell is only knowable
   after the readiness probe; (3) a `{ ... }` brace group needs `;` before
   the closing brace — `bash -n` regression test now guards both wrappers.
4. **Optional**: `bash`-tool replacement with `background`/`waitFor`,
   `ctrl+shift+b` promotion; consider offering the Windows port upstream to
   pi-bg-bash (MIT, its `ProcessPort` seam fits).

Tests: `node --test` unit tests with a fake process port (kill/timeout/watcher
paths), marker parsing, log rotation; manual acceptance above; run inherited
Pi-session checks on Windows only.

## 6. Owner decisions (2026-06-07)

1. Tool shape: separate `bg_run`/`bg_output`/`bg_tasks`/`bg_kill` tools.
2. Base: port pi-bg-bash's design (MIT, attribution).
3. Name: `pi-bg-run`.
4. Herdr default: **a new tab per task** (not harder than a split — verified
   `herdr tab create` returns the root pane directly). Auto-close on success /
   keep open on failure stands.
5. Kill: `taskkill /T /F` for detached tasks; for Herdr-mode tasks prefer
   `herdr tab close` if closing the tab tears down the process tree (verify
   in phase 3, taskkill as fallback).
6. Inspection: `bg_tasks` + `bg_output` (incl. `latest` tail) are the surface
   for an agent that stays awake and pokes at running tasks; Herdr-mode output
   is teed to the same log so inspection is uniform.
7. Cache warming (2026-10-25): activate on "a task is running" through pi's
   native cache warmer via the `cache_warming_decision` override. Rejected:
   model-facing heartbeat messages (every beat is a full turn at cache-read
   price and grows the transcript) and Herdr agent states as the idle source
   (pi exposes `isIdle()` natively; the extension stays Herdr-independent).
   User visibility is a `setStatus` footer heartbeat.
