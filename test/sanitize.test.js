const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSchema, sanitizeMessagesBody, estimateTokens } = require('../out/claude/sanitize');

test('sanitizeSchema strips grammar-hostile keywords and keeps structure', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string', format: 'uri', pattern: '^https?://', description: 'The URL' },
      count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      mode: { const: 'fast' },
      tags: { type: 'array', items: { type: 'string', maxLength: 5 }, minItems: 1 },
      nested: { properties: { x: { type: ['string', 'null'] } } },
      choice: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
    },
    required: ['url'],
  };
  const out = sanitizeSchema(schema);
  assert.equal(out.$schema, undefined);
  assert.equal(out.additionalProperties, undefined);
  assert.deepEqual(out.properties.url, { type: 'string', description: 'The URL' });
  assert.deepEqual(out.properties.count, { type: 'integer' });
  assert.deepEqual(out.properties.mode, { enum: ['fast'] });
  assert.deepEqual(out.properties.tags, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(out.properties.nested, { properties: { x: { type: ['string', 'null'] } }, type: 'object' });
  assert.deepEqual(out.properties.choice, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.deepEqual(out.required, ['url']);
});

test('sanitizeMessagesBody drops metadata, cleans tools, optionally drops MCP tools', () => {
  const body = {
    model: 'local',
    metadata: { user_id: 'secret' },
    tools: [
      { name: 'Read', input_schema: { type: 'object', properties: { p: { type: 'string', format: 'path' } } }, cache_control: { type: 'ephemeral' } },
      { name: 'mcp__server__tool', input_schema: { type: 'object' } },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  };
  const out = sanitizeMessagesBody(body, {});
  assert.equal(out.metadata, undefined);
  assert.equal(out.tools.length, 2);
  assert.equal(out.tools[0].cache_control, undefined);
  assert.equal(out.tools[0].input_schema.properties.p.format, undefined);
  assert.equal(body.metadata.user_id, 'secret', 'input is not mutated');
  const dropped = sanitizeMessagesBody(body, { dropMcpTools: true });
  assert.deepEqual(dropped.tools.map((t) => t.name), ['Read']);
});

test('estimateTokens is roughly chars/4 over system, messages and tools', () => {
  const n = estimateTokens({ system: 'a'.repeat(400), messages: [], tools: [] });
  assert.ok(n >= 100 && n <= 110, String(n));
});
