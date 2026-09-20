const test = require('node:test');
const assert = require('node:assert/strict');
const { RpcRewriter, toCodexModel } = require('../out/codex/rpc-rewrite');

function makeRewriter(overrides = {}, seedMemory = {}) {
  const state = {
    providers: [{ id: 'aiswitch', name: 'LM Studio', baseUrl: 'http://lm/v1', apiKeyEnv: 'AISWITCH_API_KEY' }],
    models: [
      { id: 'deepseek-v4-flash', contextLength: 1048576, vision: false, provider: 'aiswitch', providerName: 'LM Studio' },
      { id: 'qwen3-vl', vision: true, provider: 'aiswitch', providerName: 'LM Studio' },
    ],
    reasoningEfforts: ['low', 'medium', 'high'],
    ...overrides,
  };
  let memory = seedMemory;
  const logs = [];
  const rewriter = new RpcRewriter({
    getState: () => state,
    getMemory: () => memory,
    saveMemory: (m) => { memory = m; },
    log: (m) => logs.push(m),
  });
  return { rewriter, state, logs, memory: () => memory };
}

/** Feed a config/read round trip so the rewriter knows config.toml defaults. */
function primeConfig(rewriter, config) {
  const actions = rewriter.fromClient({ method: 'initialized' });
  assert.equal(actions[0].to, 'server');
  assert.equal(actions[1].msg.method, 'config/read');
  const own = actions[1].msg.id;
  assert.deepEqual(rewriter.fromServer({ id: own, result: { config } }), []);
}

test('toCodexModel matches the app-server Model shape', () => {
  const m = toCodexModel({ id: 'qwen3-vl', vision: true, contextLength: 262144, providerName: 'Mac Studio' }, { reasoningEfforts: ['low', 'high'] });
  assert.equal(m.id, 'qwen3-vl');
  assert.equal(m.description, 'Mac Studio · 256K context · vision');
  assert.equal(m.model, 'qwen3-vl');
  assert.deepEqual(m.inputModalities, ['text', 'image']);
  assert.deepEqual(m.supportedReasoningEfforts.map((e) => e.reasoningEffort), ['low', 'high']);
  assert.equal(m.defaultReasoningEffort, 'low');
  assert.equal(m.hidden, false);
  assert.equal(m.isDefault, false);
  assert.deepEqual(Object.keys(m).sort(), ['additionalSpeedTiers', 'availabilityNux', 'defaultReasoningEffort', 'defaultServiceTier', 'description', 'displayName', 'hidden', 'id', 'inputModalities', 'isDefault', 'model', 'modelSpecialty', 'multiAgentVersion', 'serviceTiers', 'supportedReasoningEfforts', 'supportsPersonality', 'upgrade', 'upgradeInfo']);
});

test('model/list responses gain the provider models on the last page only', () => {
  const { rewriter, memory } = makeRewriter();
  rewriter.fromClient({ id: 7, method: 'model/list', params: { includeHidden: true } });
  const [a] = rewriter.fromServer({ id: 7, result: { data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol' }], nextCursor: null } });
  assert.deepEqual(a.msg.result.data.map((m) => m.id), ['gpt-5.6-sol', 'deepseek-v4-flash', 'qwen3-vl']);
  assert.deepEqual(memory().knownModels, { 'deepseek-v4-flash': 'aiswitch', 'qwen3-vl': 'aiswitch' });

  rewriter.fromClient({ id: 8, method: 'model/list', params: {} });
  const [b] = rewriter.fromServer({ id: 8, result: { data: [{ id: 'x' }], nextCursor: 'more' } });
  assert.deepEqual(b.msg.result.data.map((m) => m.id), ['x']);
});

test('thread/start with a provider model is bound to the provider with its context window', () => {
  const { rewriter } = makeRewriter();
  const [a] = rewriter.fromClient({ id: 1, method: 'thread/start', params: { model: 'deepseek-v4-flash', cwd: '/x' } });
  assert.equal(a.to, 'server');
  assert.equal(a.msg.params.modelProvider, 'aiswitch');
  assert.equal(a.msg.params.config.model_context_window, 1048576);
  assert.equal(a.msg.params.cwd, '/x');
  // Response records the provider for the thread.
  rewriter.fromServer({ id: 1, result: { thread: { id: 't1', modelProvider: 'aiswitch' }, modelProvider: 'aiswitch' } });
  assert.equal(rewriter.threadProvider('t1'), 'aiswitch');
});

test('thread/start with a built-in model is left alone unless config defaults to our provider', () => {
  const { rewriter } = makeRewriter();
  const [a] = rewriter.fromClient({ id: 1, method: 'thread/start', params: { model: 'gpt-5.6-luna' } });
  assert.equal(a.msg.params.modelProvider, undefined);

  primeConfig(rewriter, { model: 'deepseek-v4-flash', model_provider: 'aiswitch' });
  const [b] = rewriter.fromClient({ id: 2, method: 'thread/start', params: { model: 'gpt-5.6-luna' } });
  assert.equal(b.msg.params.modelProvider, 'openai');
  // No explicit model: the config default (a provider model) applies.
  const [c] = rewriter.fromClient({ id: 3, method: 'thread/start', params: {} });
  assert.equal(c.msg.params.modelProvider, 'aiswitch');
});

test('resuming one of our threads without a model keeps the provider', () => {
  const { rewriter } = makeRewriter();
  rewriter.fromServer({ method: 'thread/started', params: { thread: { id: 't9', modelProvider: 'aiswitch' } } });
  const [a] = rewriter.fromClient({ id: 4, method: 'thread/resume', params: { threadId: 't9' } });
  assert.equal(a.msg.params.modelProvider, 'aiswitch');
  const [b] = rewriter.fromClient({ id: 5, method: 'thread/resume', params: { threadId: 'unknown' } });
  assert.equal(b.msg.params.modelProvider, undefined);
});

test('turn/start that would switch providers mid-thread is rejected with a JSON-RPC error', () => {
  const { rewriter } = makeRewriter();
  rewriter.fromServer({ method: 'thread/started', params: { thread: { id: 'gpt-thread', modelProvider: 'openai' } } });
  rewriter.fromServer({ method: 'thread/started', params: { thread: { id: 'local-thread', modelProvider: 'aiswitch' } } });

  const blocked = rewriter.fromClient({ jsonrpc: '2.0', id: 10, method: 'turn/start', params: { threadId: 'gpt-thread', model: 'deepseek-v4-flash', input: [] } });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].to, 'client');
  assert.equal(blocked[0].msg.id, 10);
  assert.equal(blocked[0].msg.jsonrpc, '2.0');
  assert.match(blocked[0].msg.error.message, /start a new chat/);

  const blocked2 = rewriter.fromClient({ id: 11, method: 'turn/start', params: { threadId: 'local-thread', model: 'gpt-5.6-luna', input: [] } });
  assert.equal(blocked2[0].to, 'client');

  const ok = rewriter.fromClient({ id: 12, method: 'turn/start', params: { threadId: 'local-thread', model: 'deepseek-v4-flash', input: [] } });
  assert.equal(ok[0].to, 'server');
  const okNoModel = rewriter.fromClient({ id: 13, method: 'turn/start', params: { threadId: 'gpt-thread', input: [] } });
  assert.equal(okNoModel[0].to, 'server');
  const unknownThread = rewriter.fromClient({ id: 14, method: 'turn/start', params: { threadId: 'nope', model: 'deepseek-v4-flash', input: [] } });
  assert.equal(unknownThread[0].to, 'server');
});

test('config/batchWrite mirrors model_provider next to model', () => {
  const { rewriter, memory } = makeRewriter();
  primeConfig(rewriter, { model: 'gpt-5.6-sol', model_provider: 'custom-gw' });
  const [a] = rewriter.fromClient({ id: 20, method: 'config/batchWrite', params: { edits: [
    { keyPath: 'model', value: 'deepseek-v4-flash', mergeStrategy: 'upsert' },
    { keyPath: 'model_reasoning_effort', value: 'medium', mergeStrategy: 'upsert' },
  ] } });
  assert.deepEqual(a.msg.params.edits[2], { keyPath: 'model_provider', value: 'aiswitch', mergeStrategy: 'upsert' });
  assert.equal(memory().originalModelProvider, 'custom-gw');
  // The write's response triggers a config re-read.
  const after = rewriter.fromServer({ id: 20, result: {} });
  assert.equal(after[1].msg.method, 'config/read');
  rewriter.fromServer({ id: after[1].msg.id, result: { config: { model: 'deepseek-v4-flash', model_provider: 'aiswitch' } } });

  const [b] = rewriter.fromClient({ id: 21, method: 'config/batchWrite', params: { edits: [{ keyPath: 'model', value: 'gpt-5.5', mergeStrategy: 'upsert' }] } });
  assert.deepEqual(b.msg.params.edits[1], { keyPath: 'model_provider', value: 'custom-gw', mergeStrategy: 'upsert' });

  const [c] = rewriter.fromClient({ id: 22, method: 'config/batchWrite', params: { edits: [{ keyPath: 'profiles.fast.model', value: 'qwen3-vl', mergeStrategy: 'upsert' }] } });
  assert.deepEqual(c.msg.params.edits[1], { keyPath: 'profiles.fast.model_provider', value: 'aiswitch', mergeStrategy: 'upsert' });
});

test('models that disappeared from the server are still recognised via memory', () => {
  const { rewriter, state } = makeRewriter();
  rewriter.fromClient({ id: 1, method: 'model/list', params: {} });
  rewriter.fromServer({ id: 1, result: { data: [], nextCursor: null } });
  state.models = [];
  assert.equal(rewriter.providerFor('DeepSeek-V4-Flash'), 'aiswitch');
  assert.ok(rewriter.isProviderModel('DeepSeek-V4-Flash'));
  assert.ok(!rewriter.isProviderModel('gpt-5.6-sol'));
});

/** Two servers at once: every model must carry its own model_providers id. */
function makeMultiRewriter() {
  return makeRewriter({
    providers: [
      { id: 'aiswitch-mac-studio', name: 'Mac Studio', baseUrl: 'http://mac:8888/v1', apiKeyEnv: 'AISWITCH_MAC_STUDIO_API_KEY' },
      { id: 'aiswitch-workstation', name: 'Workstation', baseUrl: 'http://ws:1234/v1', apiKeyEnv: 'AISWITCH_WORKSTATION_API_KEY' },
    ],
    models: [
      { id: 'glm-5.3-flash', contextLength: 1002496, provider: 'aiswitch-mac-studio', providerName: 'Mac Studio' },
      { id: 'qwen3-vl', vision: true, provider: 'aiswitch-workstation', providerName: 'Workstation' },
    ],
  });
}

test('a pre-multi-provider memory file is replaced rather than merged', () => {
  // 0.1.x stored knownModels as a list of ids; spreading that would leave numeric keys behind.
  const { rewriter, memory } = makeRewriter({}, { knownModels: ['deepseek-v4-flash', 'gone-model'] });
  rewriter.fromClient({ id: 1, method: 'model/list', params: {} });
  rewriter.fromServer({ id: 1, result: { data: [], nextCursor: null } });
  assert.deepEqual(memory().knownModels, { 'deepseek-v4-flash': 'aiswitch', 'qwen3-vl': 'aiswitch' });
});

test('with several servers each model is bound to the one that offers it', () => {
  const { rewriter, memory } = makeMultiRewriter();
  const [a] = rewriter.fromClient({ id: 1, method: 'thread/start', params: { model: 'glm-5.3-flash' } });
  assert.equal(a.msg.params.modelProvider, 'aiswitch-mac-studio');
  assert.equal(a.msg.params.config.model_context_window, 1002496);
  const [b] = rewriter.fromClient({ id: 2, method: 'thread/start', params: { model: 'qwen3-vl' } });
  assert.equal(b.msg.params.modelProvider, 'aiswitch-workstation');
  const [c] = rewriter.fromClient({ id: 3, method: 'thread/start', params: { model: 'gpt-5.6-luna' } });
  assert.equal(c.msg.params.modelProvider, undefined);

  // config.toml defaulting to either of ours must not capture a built-in model.
  primeConfig(rewriter, { model: 'glm-5.3-flash', model_provider: 'aiswitch-mac-studio' });
  const [d] = rewriter.fromClient({ id: 4, method: 'thread/start', params: { model: 'gpt-5.6-luna' } });
  assert.equal(d.msg.params.modelProvider, 'openai');

  rewriter.fromClient({ id: 5, method: 'model/list', params: {} });
  rewriter.fromServer({ id: 5, result: { data: [], nextCursor: null } });
  assert.deepEqual(memory().knownModels, { 'glm-5.3-flash': 'aiswitch-mac-studio', 'qwen3-vl': 'aiswitch-workstation' });
});

test('moving between two of our servers mid-thread is rejected like any provider switch', () => {
  const { rewriter } = makeMultiRewriter();
  rewriter.fromServer({ method: 'thread/started', params: { thread: { id: 'mac', modelProvider: 'aiswitch-mac-studio' } } });
  const blocked = rewriter.fromClient({ id: 10, method: 'turn/start', params: { threadId: 'mac', model: 'qwen3-vl', input: [] } });
  assert.equal(blocked[0].to, 'client');
  assert.match(blocked[0].msg.error.message, /runs on Workstation.*bound to Mac Studio/);
  const ok = rewriter.fromClient({ id: 11, method: 'turn/start', params: { threadId: 'mac', model: 'glm-5.3-flash', input: [] } });
  assert.equal(ok[0].to, 'server');
});

test('config/batchWrite records the right model_provider per server', () => {
  const { rewriter } = makeMultiRewriter();
  primeConfig(rewriter, { model: 'gpt-5.6-sol', model_provider: 'openai' });
  const [a] = rewriter.fromClient({ id: 20, method: 'config/batchWrite', params: { edits: [{ keyPath: 'model', value: 'qwen3-vl', mergeStrategy: 'upsert' }] } });
  assert.deepEqual(a.msg.params.edits[1], { keyPath: 'model_provider', value: 'aiswitch-workstation', mergeStrategy: 'upsert' });
});
