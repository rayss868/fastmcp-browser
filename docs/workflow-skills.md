# Workflow skills: record → generate → run

A recorded session becomes a reusable **workflow skill** that runs either
deterministically (a generated script, no AI) or adaptively (the AI follows the
run file with the MCP tools). The same artifacts support both.

## Artifacts

| File | Role |
|---|---|
| `run.jsonl` | The recorded steps — the source of truth, readable by the AI. |
| `run.mjs` | Deterministic runner generated from `run.jsonl` (data-flow, loops, TSV/CSV). |
| `SKILL.md` | opencode skill: when to use it, how to run, how to adapt and re-record. |
| `out/` | Default output directory for the captured dataset. |

## 1. Record

Static, for the whole server session:

```sh
FASTMCP_RECORD=/tmp/login-flow.jsonl   # set on the MCP server, then restart
```

Runtime, for one workflow (the AI can drive this itself):

```sh
node dist/src/cli.js record start /tmp/login-flow.jsonl
# ...drive the browser (MCP tools)...
node dist/src/cli.js record stop
node dist/src/cli.js record status
```

Only successful calls are kept. Session-scoped fields (`tabId`, `revision`) are
dropped; a snapshot `ref` is replaced by its `selector` when both were passed.
Steps that still depend on a volatile `ref`, or that target a live tab
(`browser_focus`, `browser_close`), are marked `"replayable": false` with a
reason. `browser_disconnect` and `browser_instances` are never recorded.

## 2. Annotate (optional, by hand or by the AI)

Recording produces a flat list. Add these optional fields to a step to turn it
into a workflow:

| Field | Meaning |
|---|---|
| `label` | Human-readable name for the step. |
| `capture: "rows"` | Store this step's result as a named dataset. |
| `forEach: "rows"` | Run the step once per item of a captured dataset (item available as `{{item.*}}`). |
| `repeat: 3` | Run the step a fixed number of times. |

Any string parameter can carry `{{placeholders}}`, resolved at run time from the
context (`item`, `result`, and every capture name):

```json
{"method":"browser_fill","params":{"selector":"input[name=q]","value":"{{item.query}}"},"replayable":true,"forEach":"queries"}
```

Use `browser_evaluate` with a **global expression** (no `ref`) to extract data —
it is replayable:

```json
{"method":"browser_evaluate","params":{"expression":"Array.from(document.querySelectorAll('.row')).map(r => ({ name: r.querySelector('.n').textContent }))"},"replayable":true,"capture":"rows"}
```

## 3. Generate a script

```sh
node dist/src/cli.js export --script run.jsonl run.mjs \
  [--out out/data.tsv] [--format tsv|csv] [--delay <ms>] \
  [--wait-state dom_stable|network_idle|none] [--capture rows]
```

The generator:
- refuses a run file that contains a non-replayable step;
- inserts a settle wait (`browser_wait_for`) after a navigation/action step that
  is followed by a read, unless one is already present;
- compiles placeholders and loops into the runner.

Run it:

```sh
node run.mjs
node run.mjs --out data.tsv --format tsv --delay 500
node run.mjs --browser Chrome --profile <instanceId>
```

It writes the captured dataset as **TSV by default** (paste-ready in Google
Sheets); `--format csv` switches to CSV. `--capture <name>` picks a dataset when
the run produced several.

## 4. Package a skill

```sh
node dist/src/cli.js export --skill run.jsonl <dir> [--name N] [--description D]
```

Writes `<dir>/SKILL.md`, `<dir>/run.mjs`, `<dir>/run.jsonl`, and `<dir>/out/`.
Drop `<dir>` into `.opencode/skills/` or `~/.config/opencode/skills/` and the AI
can load it.

## Deterministic vs adaptive

- **Deterministic**: `node run.mjs`. Fast, free, ideal for stable pages and bulk
  capture (hundreds of rows). Breaks if the site changes its DOM.
- **Adaptive**: the AI steps through `run.jsonl` with the MCP tools, choosing
  fresh selectors and waiting with `browser_wait_for` when the page differs. Use
  this for dynamic sites — the run file is a guide, not a cage.

## Self-update

When a workflow changes, refresh the skill:

```sh
node dist/src/cli.js record start <dir>/run.jsonl
# ...perform the new workflow...
node dist/src/cli.js record stop
node dist/src/cli.js export --skill <dir>/run.jsonl <dir>
```

`export --skill` overwrites in place, so the skill evolves with the site.

## Limits

- `tabId` is dropped, so multi-tab flows (open → process → close) do not replay.
- Dynamic pages can still break a deterministic run; fall back to the adaptive mode.
- Recorded `browser_fill` values may contain secrets (e.g. passwords). Review a
  run file before sharing a skill built from it.
- The generated `run.mjs` imports the tested runtime from this server's `dist/`,
  so it runs on the same machine as the server.
