/**
 * Headless integration test: runs the real activate() against a mocked `vscode`
 * module, fake model servers, and temporary CLAUDE_CONFIG_DIR / CODEX_HOME.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function fakeLmStudio() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'local-a' }, { id: 'local-b' }, { id: 'embed-x' }] }));
    else if (req.url === '/api/v0/models') res.end(JSON.stringify({ data: [
      { id: 'local-a', type: 'llm', state: 'loaded', max_context_length: 131072, publisher: 'pub' },
      { id: 'local-b', type: 'vlm', state: 'not-loaded' },
      { id: 'embed-x', type: 'embeddings' } ] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

/** A plain OpenAI-compatible server that reports its metadata inline, like llama.cpp behind a swapper. */
function fakeServer(models) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: models }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

function makeVscode(initialSettings, codexExtDir) {
  const settings = new Map(Object.entries(initialSettings));
  const listeners = [];
  const commands = new Map();
  const messages = [];
  const logs = [];
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    ConfigurationTarget: { Global: 1 },
    window: {
      state: { focused: true },
      createOutputChannel: () => ({ appendLine: (l) => logs.push(l), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }),
      showInformationMessage: async (m) => { messages.push(['info', m]); return undefined; },
      showErrorMessage: async (m) => { messages.push(['error', m]); return undefined; },
      showWarningMessage: async (m) => { messages.push(['warning', m]); return undefined; },
      showQuickPick: async () => undefined,
      setStatusBarMessage() {},
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id) => { messages.push(['command', id]); },
    },
    workspace: {
      getConfiguration: (section) => ({
        get: (key, fallback) => (settings.has(`${section}.${key}`) ? settings.get(`${section}.${key}`) : fallback),
        inspect: (key) => ({ globalValue: settings.get(`${section}.${key}`) }),
        update: async (key, value) => {
          if (value === undefined) settings.delete(`${section}.${key}`); else settings.set(`${section}.${key}`, value);
          for (const l of listeners) l({ affectsConfiguration: (s) => `${section}.${key}`.startsWith(s) });
        },
      }),
      onDidChangeConfiguration: (fn) => { listeners.push(fn); return { dispose() {} }; },
    },
    extensions: { getExtension: (id) => (id === 'openai.chatgpt' ? { extensionPath: codexExtDir } : undefined) },
    env: { clipboard: { writeText: async () => {} } },
  };
  return { vscode, settings, commands, messages, logs };
}

async function waitFor(pred, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('activate() wires Claude Code and Codex end to end, and Disable restores everything', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-ext-'));
  const claudeDir = path.join(tmp, 'claude');
  const codexHome = path.join(tmp, 'codex');
  const codexExtDir = path.join(tmp, 'openai.chatgpt-1.0.0');
  fs.mkdirSync(path.join(codexExtDir, 'bin', 'macos-aarch64'), { recursive: true });
  fs.writeFileSync(path.join(codexExtDir, 'bin', 'macos-aarch64', 'codex'), '#!/bin/sh\n');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'fable', permissions: { allow: ['Bash(*)'] } }, null, 2));
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexHome;

  const lm = await fakeLmStudio();
  const servers = [lm.server];
  const routerPort = await freePort();
  const { vscode, settings, commands, messages, logs } = makeVscode({
    'aiProviderSwitcher.baseUrl': lm.url,
    'aiProviderSwitcher.providerName': 'Fake Studio',
    'aiProviderSwitcher.claude.routerPort': routerPort,
    'claudeCode.environmentVariables': [{ name: 'ANTHROPIC_BASE_URL', value: 'http://gateway.example' }, { name: 'OTHER', value: '1' }],
    'chatgpt.cliExecutable': '/usr/local/bin/codex-custom',
  }, codexExtDir);

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, ...rest);
  };
  const store = new Map();
  const context = {
    globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { if (v === undefined) store.delete(k); else store.set(k, v); } },
    globalStorageUri: { fsPath: path.join(tmp, 'globalStorage') },
    extensionPath: path.resolve(__dirname, '..'),
    extension: { id: 'durosoft.ai-provider-switcher' },
    subscriptions: [],
  };
  const ext = require('../out/extension');
  try {
    ext.activate(context);
    const shim = path.join(tmp, 'globalStorage', 'codex', 'codex-shim');
    assert.ok(await waitFor(() => fs.existsSync(shim) && settings.get('chatgpt.cliExecutable') === shim), 'sync finished: ' + logs.join('\n'));

    // Claude Code: picker rows, env vars, router upstream captured from the pre-existing ANTHROPIC_BASE_URL.
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.equal(claudeSettings.model, 'fable');
    assert.deepEqual(claudeSettings.modelPicker.options.map((o) => o.model), ['local-a', 'local-b']);
    assert.equal(claudeSettings.modelPicker.options[0].description, 'Fake Studio · pub · 128K context · loaded');
    assert.equal(claudeSettings.modelPicker.options[0].behavesAs, 'claude-sonnet-4-6');
    const env = settings.get('claudeCode.environmentVariables');
    assert.deepEqual(env.find((e) => e.name === 'ANTHROPIC_BASE_URL'), { name: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${routerPort}` });
    assert.deepEqual(env.find((e) => e.name === 'OTHER'), { name: 'OTHER', value: '1' });
    assert.equal(env.find((e) => e.name === 'API_TIMEOUT_MS').value, '3600000');
    const health = await (await fetch(`http://127.0.0.1:${routerPort}/__ai_provider_switcher/health`)).json();
    assert.equal(health.service, 'ai-provider-switcher');
    assert.equal(health.anthropic, 'http://gateway.example');
    assert.deepEqual(health.providers, [lm.url.replace(/\/v1$/, '')]);

    // Codex: wrapper script, state, config.toml, setting, reload prompt.
    const script = fs.readFileSync(shim, 'utf8');
    assert.ok(script.includes(process.execPath) && script.includes(path.join('out', 'codex', 'shim-runtime.js')));
    assert.equal(fs.statSync(shim).mode & 0o111, 0o111);
    const state = JSON.parse(fs.readFileSync(path.join(tmp, 'globalStorage', 'codex', 'state.json'), 'utf8'));
    assert.deepEqual(state.providers, [{ id: 'aiswitch', name: 'Fake Studio', baseUrl: lm.url, apiKeyEnv: 'AISWITCH_API_KEY' }]);
    assert.deepEqual(state.models.map((m) => m.id), ['local-a', 'local-b']);
    assert.equal(state.realCodexHint, path.join(codexExtDir, 'bin', 'macos-aarch64', 'codex'));
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.ok(toml.startsWith('model = "gpt-5.6-sol"\n'));
    assert.ok(toml.includes('[model_providers.aiswitch]') && toml.includes(`base_url = "${lm.url}"`));
    assert.ok(messages.some(([kind, m]) => kind === 'info' && /Reload the window/.test(m)));
    assert.ok(!messages.some(([kind]) => kind === 'error'), JSON.stringify(messages));
    assert.ok(commands.has('aiProviderSwitcher.refresh'));

    // Switching to a list of servers: both are offered, each on its own model_providers entry.
    const mac = await fakeServer([
      { id: 'GLM-5.3-Flash', context_length: 1002496, loaded: true },
      { id: 'nomic-embed-text' },
    ]);
    servers.push(mac.server);
    await vscode.workspace.getConfiguration('aiProviderSwitcher').update('providers', [
      { name: 'Fake Studio', baseUrl: lm.url },
      { name: 'Mac Studio', baseUrl: mac.url, apiKey: 'sk-mac' },
    ]);
    const codexConfig = path.join(codexHome, 'config.toml');
    assert.ok(await waitFor(() => fs.readFileSync(codexConfig, 'utf8').includes('[model_providers.aiswitch-mac-studio]')), 'second sync: ' + logs.join('\n'));

    const multi = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.deepEqual(multi.modelPicker.options.map((o) => o.model), ['local-a', 'local-b', 'GLM-5.3-Flash[1m]']);
    assert.equal(multi.modelPicker.options[0].description, 'Fake Studio · pub · 128K context · loaded');
    assert.equal(multi.modelPicker.options[2].description, 'Mac Studio · 1M context · loaded');
    const multiToml = fs.readFileSync(codexConfig, 'utf8');
    assert.ok(multiToml.includes('[model_providers.aiswitch-fake-studio]'));
    assert.ok(multiToml.includes('env_key = "AISWITCH_MAC_STUDIO_API_KEY"'));
    // The id the single-server setup used is no longer ours and must not be left behind.
    assert.ok(!/\[model_providers\.aiswitch\]/.test(multiToml), multiToml);
    const multiState = JSON.parse(fs.readFileSync(path.join(tmp, 'globalStorage', 'codex', 'state.json'), 'utf8'));
    assert.deepEqual(multiState.providers.map((p) => p.id), ['aiswitch-fake-studio', 'aiswitch-mac-studio']);
    assert.equal(multiState.models.find((m) => m.id === 'GLM-5.3-Flash').provider, 'aiswitch-mac-studio');
    const multiHealth = await (await fetch(`http://127.0.0.1:${routerPort}/__ai_provider_switcher/health`)).json();
    assert.deepEqual(multiHealth.providers, [lm.url, mac.url].map((u) => u.replace(/\/v1$/, '')));

    // Disable restores everything we touched.
    await commands.get('aiProviderSwitcher.disable')();
    assert.ok(await waitFor(() => settings.get('chatgpt.cliExecutable') === '/usr/local/bin/codex-custom'), 'restore finished: ' + logs.join('\n'));
    const restored = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    assert.equal(restored.modelPicker, undefined);
    assert.equal(restored.model, 'fable');
    const envAfter = settings.get('claudeCode.environmentVariables');
    assert.deepEqual(envAfter.map((e) => e.name).sort(), ['ANTHROPIC_BASE_URL', 'OTHER']);
    assert.equal(envAfter.find((e) => e.name === 'ANTHROPIC_BASE_URL').value, 'http://gateway.example');
    assert.ok(!fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8').includes('model_providers'));
    await assert.rejects(fetch(`http://127.0.0.1:${routerPort}/__ai_provider_switcher/health`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    await ext.deactivate();
    Module._load = originalLoad;
    for (const s of servers) s.close();
  }
});
