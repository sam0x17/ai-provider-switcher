const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { filterModels, describeModel, providerOrigin, formatContext, fetchProviderModels, fetchAllProviderModels, normalizeBaseUrl } = require('../out/models');
const { matchesAny } = require('../out/util/glob');

test('glob matching is case-insensitive with * and ?', () => {
  assert.ok(matchesAny('Text-Embedding-Nomic', ['*embed*']));
  assert.ok(matchesAny('qwen3', ['qwen?']));
  assert.ok(!matchesAny('qwen35', ['qwen?']));
  assert.ok(!matchesAny('anything', ['', '  ']));
});

test('filterModels hides embeddings and honours include/exclude', () => {
  const models = [
    { id: 'deepseek-v4-flash', type: 'llm' },
    { id: 'text-embedding-nomic', type: 'embeddings' },
    { id: 'whisper-large' },
    { id: 'qwen3-vl', type: 'vlm' },
  ];
  assert.deepEqual(filterModels(models, { include: [], exclude: ['*whisper*'] }).map((m) => m.id), ['deepseek-v4-flash', 'qwen3-vl']);
  assert.deepEqual(filterModels(models, { include: ['qwen*'], exclude: [] }).map((m) => m.id), ['qwen3-vl']);
});

test('providerOrigin and normalizeBaseUrl strip /v1 and slashes', () => {
  assert.equal(providerOrigin('http://192.168.1.128:1234/v1/'), 'http://192.168.1.128:1234');
  assert.equal(providerOrigin('http://host:11434'), 'http://host:11434');
  assert.equal(normalizeBaseUrl(' http://h/v1/ '), 'http://h/v1');
});

test('describeModel and formatContext produce compact labels', () => {
  assert.equal(formatContext(1048576), '1M');
  assert.equal(formatContext(262144), '256K');
  const m = { id: 'x', publisher: 'unsloth', quantization: 'Q8_K_XL', contextLength: 1048576, loaded: true, vision: true };
  assert.equal(describeModel(m, 'LM Studio'), 'LM Studio · unsloth · Q8_K_XL · 1M context · vision · loaded');
  // A model that knows its own provider labels itself with it.
  assert.equal(describeModel({ ...m, providerName: 'Mac Studio' }, 'ignored'), 'Mac Studio · unsloth · Q8_K_XL · 1M context · vision · loaded');
});

test('fetchProviderModels merges /v1/models with LM Studio metadata', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'embed' }] }));
    } else if (req.url === '/api/v0/models') {
      res.end(JSON.stringify({ data: [
        { id: 'a-model', type: 'llm', state: 'loaded', max_context_length: 131072, publisher: 'p', quantization: 'Q4' },
        { id: 'embed', type: 'embeddings', state: 'not-loaded' },
        { id: 'b-model', type: 'vlm', state: 'not-loaded', capabilities: ['tool_use'] },
      ] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    const models = await fetchProviderModels({ baseUrl: base });
    assert.deepEqual(models.map((m) => m.id), ['a-model', 'b-model', 'embed']); // loaded first
    assert.equal(models[0].contextLength, 131072);
    assert.equal(models[1].vision, true);
    assert.equal(models[1].toolUse, true);
    assert.equal(models[2].type, 'embeddings');
    assert.deepEqual(filterModels(models, { include: [], exclude: [] }).map((m) => m.id), ['a-model', 'b-model']);
  } finally {
    server.close();
  }
});

test('metadata inline in /v1/models is read, with the served context winning', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [
        { id: 'glm-5.3-flash', context_length: 1002496, max_context_length: 1048576, native_context_length: 1048576, loaded: true, owned_by: 'unsloth-studio' },
        { id: 'mistral-small', quant: 'Q6_K', loaded: false },
        { id: 'served-by-vllm', max_model_len: 131072 },
      ] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const models = await fetchProviderModels({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, id: 'mac', name: 'Mac Studio' });
    assert.deepEqual(models.map((m) => m.id), ['glm-5.3-flash', 'mistral-small', 'served-by-vllm']); // loaded first
    assert.equal(models[0].contextLength, 1002496);
    assert.equal(models[0].loaded, true);
    assert.equal(models[1].quantization, 'Q6_K');
    assert.equal(models[1].loaded, false);
    assert.equal(models[2].contextLength, 131072);
    assert.equal(models[0].provider, 'mac');
    assert.equal(describeModel(models[0]), 'Mac Studio · 1M context · loaded');
  } finally {
    server.close();
  }
});

test('fetchAllProviderModels merges every server, keeps the first id wins, and reports failures', async () => {
  const make = (ids) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    return server;
  };
  const a = make(['shared', 'only-a']);
  const b = make(['shared', 'only-b', 'nomic-embed']);
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  try {
    const { models, errors } = await fetchAllProviderModels([
      { id: 'a', name: 'A', baseUrl: `http://127.0.0.1:${a.address().port}/v1` },
      { id: 'b', name: 'B', baseUrl: `http://127.0.0.1:${b.address().port}/v1`, exclude: ['*embed*'] },
      { id: 'down', name: 'Down', baseUrl: 'http://127.0.0.1:1/v1' },
    ]);
    assert.deepEqual(models.map((m) => m.id), ['shared', 'only-a', 'only-b']);
    assert.deepEqual(models.map((m) => m.provider), ['a', 'a', 'b']);
    assert.equal(models[0].providerName, 'A');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].id, 'down');
  } finally {
    a.close();
    b.close();
  }
});
