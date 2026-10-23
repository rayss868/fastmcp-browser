import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { TOOL_NAMES } from '../dist/src/tools.js';

// Skills ship with the repository in `skills/<name>/SKILL.md` so a clone (or a
// GitHub reader) gets them too; copy or symlink the folder into a runtime's
// skill directory to activate it. A malformed frontmatter or a description that
// does not start with "Use when" makes the skill invisible, so the same drift
// guard the tool registry has applies here.

const skillsRoot = resolve(fileURLToPath(new URL('../../skills', import.meta.url)));

async function skillEntries() {
  const entries = [];
  for (const name of await readdir(skillsRoot)) {
    try {
      const text = await readFile(resolve(skillsRoot, name, 'SKILL.md'), 'utf8');
      entries.push({ dir: name, text });
    } catch {
      // A directory without SKILL.md is not a skill.
    }
  }
  return entries;
}

function frontmatter(text: string): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return { body: text };
  const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
  return { name, description, body: match[2] };
}

test('every project skill has valid frontmatter that names its directory', async () => {
  const entries = await skillEntries();
  assert.ok(entries.length >= 3, 'expected the browser, Sheets, and Docs skills');
  for (const { dir, text } of entries) {
    const { name, description } = frontmatter(text);
    assert.ok(name, `${dir}: missing name`);
    assert.ok(description, `${dir}: missing description`);
    assert.equal(name, dir, `${dir}: name must match the directory`);
    assert.match(name!, /^[a-z0-9-]+$/, `${dir}: name must be lowercase letters, numbers, and hyphens`);
    assert.ok(description!.length <= 1024, `${dir}: description exceeds 1024 characters`);
    assert.match(description!, /^Use when\b/, `${dir}: description must start with "Use when" so it triggers`);
  }
});

test('skill bodies stay small enough to load cheaply', async () => {
  for (const { dir, text } of await skillEntries()) {
    const lines = text.split('\n').length;
    assert.ok(lines < 500, `${dir}: body is ${lines} lines; split it before it reaches 500`);
  }
});

test('skills only reference tools that exist in the registry', async () => {
  const known = new Set<string>(TOOL_NAMES);
  for (const { dir, text } of await skillEntries()) {
    // Match a bare tool name; the prefixed form `mcp__server__browser_x` would
    // otherwise capture the `browser_` part of the prefix.
    for (const [tool] of text.matchAll(/(?<![A-Za-z0-9_-])browser_[a-z_]+/g)) {
      assert.ok(known.has(tool), `${dir}: references unknown tool ${tool}`);
    }
  }
});

test('the Sheets and Docs skills are pointed at from the workspace tool description', async () => {
  const { getToolDefinitions } = await import('../dist/src/tools.js');
  const info = getToolDefinitions().find(tool => tool.name === 'browser_workspace_info');
  assert.ok(info, 'browser_workspace_info missing');
  assert.match(info!.description, /automating-google-sheets/);
  assert.match(info!.description, /automating-google-docs/);
});
