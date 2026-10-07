import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordedStep } from './record.js';

export type SkillOptions = {
  name: string;
  description: string;
  runFile: string;
  scriptFile: string;
  format: 'tsv' | 'csv';
};

export function skillMarkdown(steps: RecordedStep[], runName: string, options: SkillOptions): string {
  const scriptName = options.scriptFile.split(/[\\/]/).pop() ?? 'run.mjs';
  const runNameFile = options.runFile.split(/[\\/]/).pop() ?? 'run.jsonl';
  const capture = steps.find(step => step.capture)?.capture;
  const labels = steps
    .map((step, index) => `  ${index + 1}. ${step.label ?? step.method}${step.capture ? ` (capture: ${step.capture})` : ''}${step.forEach ? ` (forEach: ${step.forEach})` : ''}${step.repeat ? ` (repeat: ${step.repeat})` : ''}`)
    .join('\n');
  return `---
name: ${options.name}
description: "${options.description.replace(/"/g, '\\"')}"
---

# Workflow skill: ${options.name} (${runName})

${options.description}

Replays a recorded fastmcp-browser workflow and writes the captured dataset as ${options.format.toUpperCase()} (paste-ready for Google Sheets).

## Run it (deterministic, no AI)

\`\`\`sh
node ${scriptName}
node ${scriptName} --out data.${options.format}            # custom output
node ${scriptName} --format csv --delay 500               # CSV, 500ms between steps
node ${scriptName} --browser Chrome --profile <instanceId># pick a browser profile
\`\`\`

Requires the MCP server running + the extension connected. Output defaults to \`out/data.${options.format}\`.

## Adaptive run (AI)

If the page changed, selectors drift, or the site varies per run: do **not** force the script.
Instead step through \`${runNameFile}\` with the fastmcp-browser MCP tools, reading the live DOM and
adapting (choose fresh selectors, wait with \`browser_wait_for\`), then capture the dataset the
same way. This is the flexible mode — the run file is a guide, not a cage.

## Re-record / self-update

When a workflow changes, refresh this skill:

\`\`\`sh
node dist/src/cli.js record start ${runNameFile}
# ...perform the workflow in the browser...
node dist/src/cli.js record stop
node dist/src/cli.js export --skill ${runNameFile} <this-dir>
\`\`\`

## Steps${labels ? `\n\n\`\`\`\n${labels}\n\`\`\`` : ''}

${capture ? `Captured dataset: \`${capture}\`.\n\n` : ''}Annotations in \`${runNameFile}\`: \`capture\`, \`repeat\`, \`forEach\`, and \`{{placeholder}}\` values feed data between steps. See docs/workflow-skills.md.
`;
}

export async function writeSkill(steps: RecordedStep[], runName: string, dir: string, options: SkillOptions): Promise<{ dir: string; skillFile: string; scriptFile: string }> {
  await mkdir(join(dir, 'out'), { recursive: true });
  const skillFile = join(dir, 'SKILL.md');
  await writeFile(skillFile, skillMarkdown(steps, runName, options), 'utf8');
  return { dir, skillFile, scriptFile: options.scriptFile };
}
