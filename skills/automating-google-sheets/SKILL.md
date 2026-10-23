---
name: automating-google-sheets
description: Use when a task requires reading, writing, or filling cells in a Google Sheets tab through the mcp__fastmcp-browser__browser_workspace_* tools, or when a Sheets snapshot shows only a toolbar because the grid is a canvas. Covers selecting A1 ranges, committing values and formulas, reading data, and the limits of the formula-bar path.
---

# Automating Google Sheets

Google Sheets paints its grid to a `<canvas>`; the DOM contains the toolbar,
the Name Box (`#t-name-box`), and the formula bar
(`#t-formula-bar-input .cell-input`). The workspace tools drive those surfaces,
which is the same path a keyboard user takes, so edits are real document edits.

## First call

```
browser_workspace_info { tabId }
```

Expect `{ app: "sheets", id, gid, canvas: true, nameBox: true, formulaBar: true }`.
If `nameBox` or `formulaBar` is false the editor is still loading — wait with
`browser_wait_for { state: "dom_stable" }` and retry. An unsaved sheet has
`id: null`; save it before any read.

## Write

```
browser_workspace_write { tabId, range: "B2", value: "Hello" }
browser_workspace_write { tabId, range: "A1", value: "=SUM(B2:B10)" }
browser_workspace_write { tabId, range: "A1", values: [["Name","Score"],["Ana",10]] }
```

- `value` writes one cell or formula. Formulas must start with `=`.
- `values` writes a matrix starting at `range`, one cell per commit. Each entry
  reports `{ cell, ok, value }` where `value` is the read-back.
- The tool selects the address in the Name Box, sets the formula bar, presses
  Enter, re-selects the cell, and reads it back. `ok: false` means the read-back
  did not match — inspect `value` before assuming the write landed.
- Numbers written as strings become numbers only if the cell format allows it;
  for exact text (leading zeros, IDs) prefix with an apostrophe: `"'00123"`.

## Read

```
browser_workspace_read { tabId, range: "A1:D20" }
browser_workspace_read { tabId }                  // whole sheet, export path
browser_workspace_read { tabId, gid: "123456" }   // a specific sheet tab
```

- The tool first fetches the cookie-authenticated CSV export. That is the fast
  path and returns `source: "csv-export"`.
- Some accounts answer the export with an empty body. The tool then falls back
  to walking the range cell by cell through the formula bar and returns
  `source: "formula-bar"`. With no range that fallback reads `A1:J50`.
- The fallback is slow (one selection per cell). Always pass a range that is no
  larger than the data you need, and raise `maxRows`/`maxCols` deliberately.
- Empty trailing rows are trimmed by the export path; the fallback stops after
  five blank rows.

## Selecting without writing

`browser_workspace_select { tabId, range: "C3" }` moves the selection and
returns `{ range, value }` from the formula bar. Use it to inspect one cell
cheaply, or to position the cursor before a keyboard-driven step.

## Multi-sheet work

The `gid` in the tab URL identifies the visible sheet. For another sheet, pass
its numeric `gid` to `browser_workspace_read`. To write on another sheet, click
its tab first (`browser_snapshot` `format:"digest"`, then `browser_click`), then
write — the Name Box applies to the active sheet.

## Common mistakes

| Mistake | Result | Fix |
|---|---|---|
| Screenshot + pixel clicks on the grid | Wrong cell after any scroll/zoom | Use the workspace tools |
| `browser_evaluate` to read cells | `UNSUPPORTED_CAPABILITY` (CSP blocks eval) | `browser_workspace_read` |
| Writing a whole row as one TSV string | All text lands in the first cell | Pass `values` as a 2D array |
| Assuming `changed: true` means saved | Commit can silently no-op | Check the per-cell `ok`/read-back |
| Reading `A1:Z1000` | Minutes of per-cell walking | Read only the used range |

## Verify

After a write, re-read the same range and compare. A write is only confirmed when
the read-back matches; a reload (`browser_press { key: "F5" }`) followed by a
read proves persistence.
