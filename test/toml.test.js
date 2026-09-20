const test = require('node:test');
const assert = require('node:assert/strict');
const { upsertTable, removeTable, readStringKey, tomlString, findTable } = require('../out/util/toml');

const sample = `model = "gpt-5.6-sol"
model_reasoning_effort = "ultra"

[projects."/Users/me/x"]
trust_level = "trusted"

[model_providers.other]
name = "Other"
base_url = "http://other/v1"

[profiles.fast]
model = "gpt-5.6-luna"
`;

test('upsertTable appends a new table at the end', () => {
  const out = upsertTable(sample, 'model_providers.aiswitch', ['name = "LM Studio"', 'wire_api = "responses"']);
  assert.ok(out.endsWith('[model_providers.aiswitch]\nname = "LM Studio"\nwire_api = "responses"\n'));
  assert.ok(out.startsWith(sample.trimEnd()));
});

test('upsertTable replaces an existing table without touching neighbours', () => {
  const withOurs = upsertTable(sample, 'model_providers.aiswitch', ['name = "A"']);
  const updated = upsertTable(withOurs, 'model_providers.aiswitch', ['name = "B"', 'base_url = "http://b/v1"']);
  assert.equal((updated.match(/\[model_providers\.aiswitch\]/g) || []).length, 1);
  assert.ok(updated.includes('name = "B"'));
  assert.ok(!updated.includes('name = "A"'));
  assert.ok(updated.includes('[model_providers.other]\nname = "Other"'));
  assert.ok(updated.includes('[profiles.fast]\nmodel = "gpt-5.6-luna"'));
});

test('upsertTable replaces a table in the middle and keeps following tables', () => {
  const updated = upsertTable(sample, 'model_providers.other', ['name = "Replaced"']);
  assert.ok(updated.includes('[model_providers.other]\nname = "Replaced"\n\n[profiles.fast]'));
  assert.ok(!updated.includes('http://other/v1'));
});

test('removeTable deletes only the named table', () => {
  const out = removeTable(sample, 'model_providers.other');
  assert.ok(!out.includes('[model_providers.other]'));
  assert.ok(!out.includes('http://other/v1'));
  assert.ok(out.includes('[profiles.fast]'));
  assert.equal(removeTable(sample, 'model_providers.missing'), sample);
});

test('readStringKey reads root and table keys', () => {
  assert.equal(readStringKey(sample, undefined, 'model'), 'gpt-5.6-sol');
  assert.equal(readStringKey(sample, 'profiles.fast', 'model'), 'gpt-5.6-luna');
  assert.equal(readStringKey(sample, 'model_providers.other', 'base_url'), 'http://other/v1');
  assert.equal(readStringKey(sample, undefined, 'missing'), undefined);
});

test('findTable tolerates quoted keys and comments', () => {
  const lines = ['[ "model_providers" . "aiswitch" ] # mine', 'name = "x"', '[other]'];
  assert.deepEqual(findTable(lines, 'model_providers.aiswitch'), [0, 2]);
});

test('tomlString escapes quotes and backslashes', () => {
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
});
