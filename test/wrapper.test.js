const { test } = require('node:test');
const assert = require('node:assert/strict');
const { appServerCommand } = require('../out/codex/wrapper');

test('app-server wrappers preserve real binary, provider overrides and literal arguments', () => {
  const real = '/Applications/Codex App/bin/codex';
  const args = ['-c', 'model_providers.test.env_key="PRIVATE_TEST_KEY"', 'app-server', '--analytics-default-enabled'];
  assert.deepEqual(appServerCommand(real, args), { binary: real, args });
  const wrapper = "/tmp/gent '$literal wrapper";
  assert.deepEqual(appServerCommand(real, args, wrapper), { binary: wrapper, args: [real, ...args] });
  for (const bad of ['relative', '/tmp/line\nbreak', real]) assert.throws(() => appServerCommand(real, args, bad));
});
