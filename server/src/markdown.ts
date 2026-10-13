import { writeFile } from 'node:fs/promises';
import type { RecordedStep } from './runfile.js';

function shellCommand(method: string, params: Record<string, unknown>): string {
  return `npm run call -- ${method} '${JSON.stringify(params)}'`;
}

export function stepsToMarkdown(name: string, steps: RecordedStep[], runFile: string): string {
  const lines = [
    `# Workflow: ${name}`,
    '',
    'Recorded from a fastmcp-browser session. Replay without AI:',
    '',
    '```sh',
    `node dist/src/cli.js replay ${runFile}`,
    '```',
    '',
    'Requires: MCP server running (`npm run dev` in `server/`), extension connected.',
    'Steps flagged with a warning need a manual fix (usually: replace a snapshot ref with a selector) before replay is faithful.',
    '',
    '## Steps',
    ''
  ];
  steps.forEach((step, index) => {
    lines.push(`### ${index + 1}. \`${step.method}\``);
    lines.push('');
    if (step.replayable) {
      lines.push('```sh');
      lines.push(shellCommand(step.method, step.params));
      lines.push('```');
    } else {
      lines.push(`> ⚠️ Not directly replayable: ${step.reason ?? 'needs attention'}.`);
      lines.push('>');
      lines.push(`> Recorded params: \`${JSON.stringify(step.params)}\``);
    }
    lines.push('');
  });
  return lines.join('\n');
}

export async function exportMarkdown(runFile: string, steps: RecordedStep[], outFile: string): Promise<string> {
  const name = runFile.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, '') || 'run';
  await writeFile(outFile, stepsToMarkdown(name, steps, runFile), 'utf8');
  return outFile;
}
