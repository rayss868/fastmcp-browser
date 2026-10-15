import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge } from './bridge.js';
import { TOOL_NAMES, TOOL_DOCS, callBrowserTool } from './tools.js';
import { zodSchemas as schemas } from './schemas.js';
import { recordingStatus, startRecording, stopRecording } from './recorder.js';

const port = Number(process.env.FASTMCP_PORT ?? 9229);
function handleControl(name: string, params: Record<string, unknown>): unknown {
  if (name !== 'record') {
    throw Object.assign(new Error(`Unknown control: ${name}`), { code: 'UNSUPPORTED_CAPABILITY' });
  }
  const action = typeof params.action === 'string' ? params.action : '';
  if (action === 'start') {
    const file = params.file;
    if (typeof file !== 'string' || !file) throw Object.assign(new Error('record start requires a file path'), { code: 'INVALID_ARGUMENT' });
    return startRecording(file);
  }
  if (action === 'stop') return stopRecording();
  if (action === 'status') return recordingStatus();
  throw Object.assign(new Error(`Unknown record action: ${action || '(none)'}`), { code: 'INVALID_ARGUMENT' });
}

const bridge = createBridge(port, undefined, { control: handleControl });
const server = new McpServer({ name: 'fastmcp-browser', version: '0.6.0' });

function toMcpContent(result: unknown): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.dataUrl === 'string') {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(record.dataUrl);
      if (match) {
        const { dataUrl: _dataUrl, ...metadata } = record;
        return [
          { type: 'image' as const, data: match[2], mimeType: match[1] },
          { type: 'text' as const, text: JSON.stringify(metadata) },
        ];
      }
    }
  }
  return [{ type: 'text' as const, text: JSON.stringify(result ?? null) }];
}

for (const name of TOOL_NAMES) {
  const inputSchema = schemas[name];
  server.registerTool(name, { description: TOOL_DOCS[name] ?? `FastMCP Browser ${name}`, inputSchema }, async (args: Record<string, unknown>) => {
    try {
      const result = await callBrowserTool(bridge, name, args);
      return { content: toMcpContent(result) };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: (error as { code?: string }).code ?? 'ACTION_TIMEOUT', message: error instanceof Error ? error.message : String(error) }) }] };
    }
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  await server.close();
  await bridge.close();
};
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
