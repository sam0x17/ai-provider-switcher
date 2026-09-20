const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPickerRows, buildModelPicker, readSettingsJson, writeSettingsJson, samePicker } = require('../out/claude/settings');

test('buildPickerRows produces modelPicker rows with labels and behavesAs', () => {
  const rows = buildPickerRows([{ id: 'deepseek', publisher: 'unsloth', contextLength: 1048576 }, { id: 'qwen' }], 'LM Studio', 'claude-sonnet-4-6');
  assert.deepEqual(rows[0], { model: 'deepseek[1m]', label: 'deepseek', description: 'LM Studio · unsloth · 1M context', behavesAs: 'claude-sonnet-4-6' });
  assert.equal(rows[1].model, 'qwen');
  assert.equal(buildPickerRows([{ id: 'x' }], 'P', '  ')[0].behavesAs, undefined);
  assert.deepEqual(buildModelPicker(rows, false), { options: rows });
  assert.deepEqual(buildModelPicker(rows, true), { options: rows, replaceBuiltInOptions: true });
});

test('settings.json round trip keeps other keys and tolerates missing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-'));
  const file = path.join(dir, 'settings.json');
  assert.deepEqual(readSettingsJson(file), {});
  const json = { permissions: { allow: ['Bash(*)'] }, model: 'fable' };
  json.modelPicker = { options: [{ model: 'x' }] };
  writeSettingsJson(file, json);
  const back = readSettingsJson(file);
  assert.deepEqual(back, json);
  assert.ok(samePicker(back.modelPicker, { options: [{ model: 'x' }] }));
  assert.ok(!samePicker(back.modelPicker, undefined));
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('}\n'), true);
  fs.writeFileSync(file, '[]');
  assert.throws(() => readSettingsJson(file), /JSON object/);
});
