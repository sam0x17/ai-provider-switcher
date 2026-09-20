const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { providerTableBody, providerOverrides, writeProviderToConfig, removeProviderFromConfig, STREAM_IDLE_TIMEOUT_MS } = require('../out/codex/config');

const entry = { providerId: 'aiswitch', name: 'LM Studio', baseUrl: 'http://192.168.1.128:1234/v1' };

test('provider table and -c overrides agree and use the Responses API', () => {
  const body = providerTableBody(entry).join('\n');
  assert.match(body, /name = "LM Studio"/);
  assert.match(body, /base_url = "http:\/\/192\.168\.1\.128:1234\/v1"/);
  assert.match(body, /wire_api = "responses"/);
  assert.match(body, /requires_openai_auth = false/);
  assert.match(body, new RegExp(`stream_idle_timeout_ms = ${STREAM_IDLE_TIMEOUT_MS}`));
  assert.ok(!body.includes('env_key'));
  assert.match(providerTableBody({ ...entry, apiKeyEnv: 'AISWITCH_API_KEY' }).join('\n'), /env_key = "AISWITCH_API_KEY"/);

  const args = providerOverrides({ ...entry, apiKeyEnv: 'AISWITCH_API_KEY' });
  assert.equal(args.filter((a) => a === '-c').length, 6);
  assert.ok(args.includes('model_providers.aiswitch.base_url="http://192.168.1.128:1234/v1"'));
  assert.ok(args.includes('model_providers.aiswitch.env_key="AISWITCH_API_KEY"'));
});

test('writeProviderToConfig upserts the table and removeProviderFromConfig removes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-codex-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'model = "gpt-5.6-sol"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
  writeProviderToConfig(entry, file);
  let text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('model = "gpt-5.6-sol"\n\n[projects."/x"]\ntrust_level = "trusted"\n\n[model_providers.aiswitch]\n'));
  writeProviderToConfig({ ...entry, baseUrl: 'http://other/v1' }, file);
  text = fs.readFileSync(file, 'utf8');
  assert.equal((text.match(/\[model_providers\.aiswitch\]/g) || []).length, 1);
  assert.ok(text.includes('http://other/v1') && !text.includes('192.168.1.128'));
  removeProviderFromConfig('aiswitch', file);
  text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('model_providers'));
  assert.ok(text.includes('[projects."/x"]\ntrust_level = "trusted"'));
  // Missing file: created.
  const fresh = path.join(dir, 'fresh.toml');
  writeProviderToConfig(entry, fresh);
  assert.ok(fs.readFileSync(fresh, 'utf8').startsWith('[model_providers.aiswitch]\n'));
});
