const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ClaudeRouter, decideRoute } = require('../out/claude/router');

function fakeUpstream(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return { server, calls, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))) };
}

test('decideRoute picks the provider only for POST /v1/messages with a provider model', () => {
  const target = { name: 'Mac Studio', origin: 'http://mac:8888' };
  const resolve = (m) => (m === 'local-1' ? target : undefined);
  const body = (m) => Buffer.from(JSON.stringify({ model: m }));
  assert.deepEqual(decideRoute('POST', '/v1/messages?beta=true', body('local-1'), resolve), { target: 'provider', model: 'local-1', provider: target });
  assert.deepEqual(decideRoute('POST', '/v1/messages', body('claude-opus-5'), resolve), { target: 'anthropic', model: 'claude-opus-5' });
  assert.deepEqual(decideRoute('POST', '/v1/messages/count_tokens', body('local-1'), resolve), { target: 'local-count-tokens', model: 'local-1' });
  assert.deepEqual(decideRoute('GET', '/v1/models', Buffer.alloc(0), resolve), { target: 'anthropic' });
  assert.deepEqual(decideRoute('POST', '/v1/messages', Buffer.from('not json'), resolve), { target: 'anthropic' });
});

test('router forwards by model, strips Anthropic credentials from provider traffic, streams responses', async () => {
  const anthropic = fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1' });
    res.end(JSON.stringify({ ok: 'anthropic', url: req.url }));
  });
  const provider = fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    setTimeout(() => { res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); res.end(); }, 30);
  });
  const anthropicUrl = await anthropic.listen();
  const providerUrl = await provider.listen();
  const logs = [];
  const router = new ClaudeRouter({
    port: 0,
    anthropicUpstream: anthropicUrl,
    resolveProvider: (m) => (m.startsWith('local-') ? { name: 'Local', origin: providerUrl, apiKey: 'local-key' } : undefined),
    sanitize: {},
    log: { info: (m) => logs.push(m), debug: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  await router.start();
  const base = `http://127.0.0.1:${router.port}`;
  try {
    // Anthropic model: credentials and beta headers pass through untouched, query kept.
    let res = await fetch(`${base}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer oauth-secret', 'anthropic-beta': 'x', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('request-id'), 'req_1');
    assert.deepEqual(await res.json(), { ok: 'anthropic', url: '/v1/messages?beta=true' });
    assert.equal(anthropic.calls[0].headers.authorization, 'Bearer oauth-secret');
    assert.equal(anthropic.calls[0].headers['anthropic-beta'], 'x');

    // Non-message paths go to Anthropic.
    res = await fetch(`${base}/v1/models?limit=5`);
    assert.equal(res.status, 200);
    assert.equal(anthropic.calls[1].url, '/v1/models?limit=5');

    // Provider model: streamed, credentials replaced, metadata stripped, tools sanitised.
    res = await fetch(`${base}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer oauth-secret', 'x-api-key': 'k', 'anthropic-beta': 'x', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'local-1', stream: true, metadata: { user_id: 'me' }, tools: [{ name: 't', input_schema: { type: 'object', additionalProperties: false } }], messages: [] }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.ok(text.includes('message_start') && text.includes('message_stop'));
    const call = provider.calls[0];
    assert.equal(call.url, '/v1/messages?beta=true');
    assert.equal(call.headers.authorization, 'Bearer local-key');
    assert.equal(call.headers['x-api-key'], 'local-key');
    assert.equal(call.headers['anthropic-beta'], undefined);
    const sent = JSON.parse(call.body);
    assert.equal(sent.metadata, undefined);
    assert.equal(sent.tools[0].input_schema.additionalProperties, undefined);
    assert.equal(call.headers['content-length'], String(Buffer.byteLength(call.body)));

    // count_tokens for a provider model is answered locally.
    res = await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'local-1', messages: [{ role: 'user', content: 'hello world' }] }) });
    const counted = await res.json();
    assert.ok(counted.input_tokens > 0);
    assert.equal(provider.calls.length, 1);
  } finally {
    await router.stop();
    anthropic.server.close();
    provider.server.close();
  }
});

test('router reports unreachable upstreams as Anthropic-style errors', async () => {
  const router = new ClaudeRouter({ port: 0, anthropicUpstream: 'http://127.0.0.1:1', resolveProvider: () => undefined });
  await router.start();
  try {
    const res = await fetch(`http://127.0.0.1:${router.port}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.type, 'error');
    assert.match(json.error.message, /could not reach/);
  } finally {
    await router.stop();
  }
});

test('health endpoint identifies our router and isOurRouter recognises it', async () => {
  const { isOurRouter } = require('../out/claude/router');
  const router = new ClaudeRouter({ port: 0, anthropicUpstream: 'http://127.0.0.1:1', resolveProvider: () => undefined });
  await router.start();
  try {
    assert.equal(await isOurRouter(router.port), true);
    const res = await fetch(`http://127.0.0.1:${router.port}/__ai_provider_switcher/health`);
    const json = await res.json();
    assert.equal(json.service, 'ai-provider-switcher');
    assert.equal(json.pid, process.pid);
  } finally {
    await router.stop();
  }
  assert.equal(await isOurRouter(1), false);
});

test('each model is forwarded to the server that offers it', async () => {
  const one = fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"from":"one"}'); });
  const two = fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"from":"two"}'); });
  const oneUrl = await one.listen();
  const twoUrl = await two.listen();
  const targets = {
    'glm-5.3-flash': { name: 'Mac Studio', origin: twoUrl, apiKey: 'key-two' },
    'qwen3-vl': { name: 'Workstation', origin: oneUrl, apiKey: 'key-one' },
  };
  const router = new ClaudeRouter({
    port: 0,
    anthropicUpstream: 'http://127.0.0.1:1',
    resolveProvider: (m) => targets[m.toLowerCase()],
  });
  await router.start();
  const base = `http://127.0.0.1:${router.port}`;
  try {
    const post = (model) => fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }) });
    assert.deepEqual(await (await post('qwen3-vl')).json(), { from: 'one' });
    assert.deepEqual(await (await post('GLM-5.3-Flash')).json(), { from: 'two' });
    assert.equal(one.calls.length, 1);
    assert.equal(two.calls.length, 1);
    assert.equal(one.calls[0].headers.authorization, 'Bearer key-one');
    assert.equal(two.calls[0].headers['x-api-key'], 'key-two');
  } finally {
    await router.stop();
    one.server.close();
    two.server.close();
  }
});
