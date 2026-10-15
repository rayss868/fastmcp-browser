import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolDefinitions } from '../dist/src/tools.js';
import { zodSchemas } from '../dist/src/schemas.js';

// Drift guard: the MCP client only ever sees the Zod schemas registered by
// index.ts, while the JSON schemas in tools.ts describe what the extension
// engine accepts. When the two diverged, format:"markdown" was rejected at the
// server even though the engine supported it. These tests keep both lists in
// step for every tool.

function unwrap(schema: any): any {
  let current = schema;
  while (current && (current._def?.typeName === 'ZodOptional' || current._def?.typeName === 'ZodDefault' || current._def?.typeName === 'ZodNullable')) {
    current = current._def.innerType;
  }
  return current;
}

function zodEnumValues(schema: any): string[] | undefined {
  const inner = unwrap(schema);
  if (inner?._def?.typeName === 'ZodEnum') return inner._def.values as string[];
  return undefined;
}

function jsonEnumValues(field: any): string[] | undefined {
  const values = field?.enum;
  return Array.isArray(values) ? values.map(String) : undefined;
}

test('every Zod tool schema exposes exactly the properties the JSON schema declares', () => {
  for (const tool of getToolDefinitions()) {
    const zodSchema = zodSchemas[tool.name];
    assert.ok(zodSchema, `${tool.name} has no Zod schema in schemas.ts`);
    const jsonProps = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>).sort();
    const zodProps = Object.keys(zodSchema.shape).sort();
    assert.deepEqual(zodProps, jsonProps, `${tool.name}: Zod shape and JSON properties diverged`);
  }
});

test('enum values match between the Zod and JSON schemas for every tool', () => {
  for (const tool of getToolDefinitions()) {
    const jsonProperties = (tool.inputSchema.properties ?? {}) as Record<string, any>;
    const zodShape = zodSchemas[tool.name].shape as Record<string, any>;
    for (const [key, jsonField] of Object.entries(jsonProperties)) {
      const jsonEnum = jsonEnumValues(jsonField);
      if (!jsonEnum) continue;
      const zodEnum = zodEnumValues(zodShape[key]);
      assert.ok(zodEnum, `${tool.name}.${key}: JSON declares an enum but the Zod field is not an enum`);
      assert.deepEqual([...zodEnum].sort(), [...jsonEnum].sort(), `${tool.name}.${key}: enum values diverged`);
    }
  }
});

test('browser_snapshot format reaches the client with every engine-supported value', () => {
  const snapshot = zodSchemas.browser_snapshot.shape as Record<string, any>;
  const formats = zodEnumValues(snapshot.format);
  for (const format of ['compact', 'digest', 'text', 'markdown', 'aria']) {
    assert.ok(formats?.includes(format), `Zod browser_snapshot.format must allow "${format}" — the engine implements it`);
  }
});

test('browser_scroll accepts element targets as well as raw deltas', () => {
  const scroll = zodSchemas.browser_scroll.shape as Record<string, any>;
  for (const key of ['x', 'y', 'ref', 'selector', 'revision', 'intoView']) {
    assert.ok(scroll[key], `browser_scroll.${key} missing from the Zod schema`);
  }
  const jsonScroll = getToolDefinitions().find(tool => tool.name === 'browser_scroll')!;
  const jsonProps = jsonScroll.inputSchema.properties as Record<string, { description?: string }>;
  for (const key of ['x', 'y', 'ref', 'selector', 'revision', 'intoView']) {
    assert.ok(jsonProps[key]?.description, `browser_scroll.${key} missing from the JSON schema`);
  }
});
