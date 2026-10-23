---
name: automating-google-docs
description: Use when a task requires reading or writing the body of a Google Docs document through the mcp__fastmcp-browser__browser_workspace_* tools, or when a Docs snapshot returns only the toolbar because the document body is rendered to canvas. Covers plain-text reads, writing through the event-target input, and appending versus replacing.
---

# Automating Google Docs

Google Docs renders the document body to canvases and receives keystrokes through
a hidden iframe (`.docs-texteventtarget-iframe`). A DOM snapshot therefore sees
the menus and toolbar, not the text. Use the workspace tools.

## First call

```
browser_workspace_info { tabId }
```

Expect `{ app: "docs", id, docsTarget: true }`. If `docsTarget` is false the
editor is still loading; wait for `dom_stable` and retry. An unsaved document
has `id: null`; save it before any read.

## Read

```
browser_workspace_read { tabId }
```

The tool fetches the plain-text export
(`/document/d/<id>/export?format=txt`) with the tab's session cookies and returns
`{ app: "docs", source: "txt-export", text, charCount }`. That is the only
reliable body read — `format:"text"` and `format:"markdown"` snapshots return
chrome such as "KembaliTutup sheet samping", not the document.

For structure (headings, lists) the export loses formatting. When structure
matters, read the plain text and ask the user, or use the Docs UI
(`browser_snapshot` `format:"digest"` → menus) for a specific operation.

## Write

```
browser_workspace_write { tabId, value: "Full document text" }                 // replace
browser_workspace_write { tabId, value: "Appended paragraph", replace: false } // append at caret
```

The tool focuses the event-target input and inserts the text with
`execCommand("insertText")`, which is what the editor listens to. `replace`
defaults to `true` (select all, then insert). With `replace: false` the text is
inserted at the current caret, so position the caret first if the insertion
point matters.

Newlines in `value` become new paragraphs. There is no formatting control
(bold, headings, tables) through this path — it writes plain text.

## Verify

Re-read with `browser_workspace_read` and check the text. The export can lag a
few seconds behind the editor; if the write looks missing, wait for
`dom_stable` and read again before retrying the write (a retry would append or
replace a second time).

## Common mistakes

| Mistake | Result | Fix |
|---|---|---|
| `browser_snapshot format:"text"` for the body | Only toolbar chrome | `browser_workspace_read` |
| `browser_evaluate` on Docs | `UNSUPPORTED_CAPABILITY` (CSP blocks eval) | workspace tools |
| Clicking the canvas and typing | Caret lands unpredictably | `browser_workspace_write` |
| Repeating a write after a slow read | Duplicated or lost text | Wait and re-read first |
| Expecting markdown/bold output | Plain text only | Confirm formatting needs with the user |

## Limits

- Slides is detected by `browser_workspace_info` but not yet writable; report
  that instead of pretending.
- Very large documents may exceed the 12 MB export cap; read a section by
  exporting from the UI or asking the user for the relevant part.
