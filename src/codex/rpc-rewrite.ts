import { describeModel, ProviderModel } from '../models';
import { ShimMemory, ShimState } from './state';

/** Codex app-server v2 `Model` shape (see `codex app-server generate-ts`). */
export interface CodexModel {
  id: string;
  model: string;
  upgrade: string | null;
  upgradeInfo: unknown | null;
  availabilityNux: unknown | null;
  displayName: string;
  description: string;
  modelSpecialty: string | null;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  multiAgentVersion: string | null;
  additionalSpeedTiers: string[];
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
  isDefault: boolean;
}

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
};

export function toCodexModel(m: ProviderModel, state: Pick<ShimState, 'reasoningEfforts'>): CodexModel {
  const efforts = state.reasoningEfforts ?? [];
  return {
    id: m.id,
    model: m.id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: m.id,
    description: describeModel(m),
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: EFFORT_DESCRIPTIONS[e] ?? e })),
    defaultReasoningEffort: efforts.includes('medium') ? 'medium' : efforts[0] ?? 'medium',
    inputModalities: m.vision ? ['text', 'image'] : ['text'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  };
}

export interface Action {
  to: 'server' | 'client';
  msg: any;
}

export interface RewriterDeps {
  getState(): ShimState;
  getMemory(): ShimMemory;
  saveMemory(memory: ShimMemory): void;
  log(message: string): void;
}

type JsonRpcId = string | number;

const THREAD_CREATORS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'thread/startAeon']);
const TURN_METHODS = new Set(['turn/start', 'turn/steer']);
const OWN_ID_PREFIX = 'ai-provider-switcher:';
const MODEL_KEY_RE = /^(profiles\.[^.]+\.)?model$/;

/**
 * Pure JSON-RPC rewriting for the Codex app-server connection. `fromClient` sees
 * messages the Codex extension sends; `fromServer` sees what the app-server emits.
 * Both return the messages to forward (possibly modified) plus any extra traffic.
 */
export class RpcRewriter {
  private readonly pending = new Map<JsonRpcId, { method: string; params: any }>();
  private readonly ownPending = new Map<string, (msg: any) => Action[]>();
  private readonly threadProviders = new Map<string, string>();
  private config: { model?: string; modelProvider?: string } = {};
  private ownSeq = 0;
  private useJsonRpcField = false;

  constructor(private readonly deps: RewriterDeps) {}

  get providerIds(): string[] {
    return this.deps.getState().providers.map((p) => p.id);
  }

  /** The `model_providers` id serving this model, or undefined when Codex owns it. */
  providerFor(model: unknown): string | undefined {
    if (typeof model !== 'string' || model === '') return undefined;
    const wanted = model.trim().toLowerCase();
    const state = this.deps.getState();
    const listed = state.models.find((m) => m.id.toLowerCase() === wanted);
    if (listed) return listed.provider ?? state.providers[0]?.id;
    // Unloaded or since-removed models: fall back to what we offered earlier.
    const known = this.deps.getMemory().knownModels?.[wanted];
    if (known === undefined) return undefined;
    return state.providers.some((p) => p.id === known) ? known : state.providers[0]?.id;
  }

  isProviderModel(model: unknown): model is string {
    return this.providerFor(model) !== undefined;
  }

  private isOurs(providerId: unknown): boolean {
    return typeof providerId === 'string' && this.deps.getState().providers.some((p) => p.id === providerId);
  }

  private providerName(providerId: string): string {
    return this.deps.getState().providers.find((p) => p.id === providerId)?.name ?? providerId;
  }

  threadProvider(threadId: unknown): string | undefined {
    return typeof threadId === 'string' ? this.threadProviders.get(threadId) : undefined;
  }

  // ---------------------------------------------------------------- client → server

  fromClient(msg: any): Action[] {
    if (!msg || typeof msg !== 'object') return [{ to: 'server', msg }];
    if (msg.jsonrpc === '2.0') this.useJsonRpcField = true;

    const isRequest = typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
    if (isRequest) this.pending.set(msg.id, { method: msg.method, params: msg.params });

    if (typeof msg.method !== 'string') return [{ to: 'server', msg }];

    switch (msg.method) {
      case 'initialized':
        return [{ to: 'server', msg }, this.requestConfigRead()];
      case 'thread/start':
      case 'thread/startAeon':
      case 'thread/fork':
      case 'thread/resume':
        return [{ to: 'server', msg: this.rewriteThreadCreation(msg) }];
      case 'turn/start':
      case 'turn/steer':
        return this.rewriteTurn(msg);
      case 'config/batchWrite':
        return [{ to: 'server', msg: this.rewriteConfigWrite(msg) }];
      default:
        return [{ to: 'server', msg }];
    }
  }

  private rewriteThreadCreation(msg: any): any {
    const params = { ...(msg.params ?? {}) };
    const state = this.deps.getState();
    const explicitModel = typeof params.model === 'string' ? params.model : undefined;
    let effectiveModel = explicitModel;
    if (effectiveModel === undefined && msg.method === 'thread/start') effectiveModel = this.config.model;

    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const rememberedProvider = threadId ? this.threadProviders.get(threadId) : undefined;
    const provider = this.providerFor(effectiveModel);

    if (provider !== undefined) {
      params.modelProvider = provider;
      const ctx = state.models.find((m) => m.id.toLowerCase() === effectiveModel!.toLowerCase())?.contextLength;
      if (ctx && (params.config == null || params.config.model_context_window == null)) {
        params.config = { ...(params.config ?? {}), model_context_window: ctx };
      }
      this.deps.log(`${msg.method}: ${effectiveModel} -> modelProvider=${provider}`);
    } else if (effectiveModel !== undefined) {
      // A built-in model must not run on one of our providers even if config.toml currently defaults to one.
      if (params.modelProvider == null && this.isOurs(this.config.modelProvider)) {
        params.modelProvider = this.deps.getMemory().originalModelProvider ?? 'openai';
        this.deps.log(`${msg.method}: ${effectiveModel} -> modelProvider=${params.modelProvider} (config default is ours)`);
      }
    } else if (rememberedProvider !== undefined && this.isOurs(rememberedProvider) && params.modelProvider == null) {
      // Resuming/forking one of our threads without an explicit model: keep it on the same server.
      params.modelProvider = rememberedProvider;
    }
    return { ...msg, params };
  }

  private rewriteTurn(msg: any): Action[] {
    const params = msg.params ?? {};
    const model = typeof params.model === 'string' ? params.model : undefined;
    if (model === undefined) return [{ to: 'server', msg }];
    const threadProvider = this.threadProviders.get(params.threadId);
    if (threadProvider === undefined) return [{ to: 'server', msg }];
    const wanted = this.providerFor(model);
    if (wanted === threadProvider) return [{ to: 'server', msg }];
    if (wanted === undefined && !this.isOurs(threadProvider)) return [{ to: 'server', msg }];
    this.pending.delete(msg.id);
    const target = wanted === undefined ? 'its original provider' : this.providerName(wanted);
    const message = `AI Provider Switcher: "${model}" runs on ${target}, but this chat is bound to ${
      this.isOurs(threadProvider) ? this.providerName(threadProvider) : threadProvider
    }. Codex cannot switch providers mid-thread — start a new chat with this model instead.`;
    this.deps.log(`blocked ${msg.method} on thread ${params.threadId}: ${message}`);
    return [{ to: 'client', msg: this.errorResponse(msg.id, -32602, message) }];
  }

  private rewriteConfigWrite(msg: any): any {
    const params = msg.params ?? {};
    if (!Array.isArray(params.edits)) return msg;
    const memory = this.deps.getMemory();
    const edits: any[] = [...params.edits];
    for (const edit of params.edits) {
      const match = typeof edit?.keyPath === 'string' ? MODEL_KEY_RE.exec(edit.keyPath) : null;
      if (!match || typeof edit.value !== 'string') continue;
      const prefix = match[1] ?? '';
      const providerKey = `${prefix}model_provider`;
      if (edits.some((e) => e?.keyPath === providerKey)) continue;
      const provider = this.providerFor(edit.value);
      if (provider !== undefined) {
        if (prefix === '' && this.config.modelProvider && !this.isOurs(this.config.modelProvider)) {
          memory.originalModelProvider = this.config.modelProvider;
          this.deps.saveMemory(memory);
        }
        edits.push({ keyPath: providerKey, value: provider, mergeStrategy: 'upsert' });
        this.deps.log(`config write: ${edit.keyPath}=${edit.value} -> also ${providerKey}=${provider}`);
      } else if (prefix === '' && this.isOurs(this.config.modelProvider)) {
        const restore = memory.originalModelProvider ?? 'openai';
        edits.push({ keyPath: providerKey, value: restore, mergeStrategy: 'upsert' });
        this.deps.log(`config write: ${edit.keyPath}=${edit.value} -> restoring ${providerKey}=${restore}`);
      }
    }
    return { ...msg, params: { ...params, edits } };
  }

  // ---------------------------------------------------------------- server → client

  fromServer(msg: any): Action[] {
    if (!msg || typeof msg !== 'object') return [{ to: 'client', msg }];

    const isResponse = msg.id !== undefined && msg.id !== null && typeof msg.method !== 'string';
    if (isResponse) {
      if (typeof msg.id === 'string' && msg.id.startsWith(OWN_ID_PREFIX)) {
        const handler = this.ownPending.get(msg.id);
        this.ownPending.delete(msg.id);
        return handler ? handler(msg) : [];
      }
      const req = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!req) return [{ to: 'client', msg }];
      return this.rewriteResponse(req, msg);
    }

    if (typeof msg.method === 'string') this.observeNotification(msg);
    return [{ to: 'client', msg }];
  }

  private rewriteResponse(req: { method: string; params: any }, msg: any): Action[] {
    const result = msg.result;
    switch (req.method) {
      case 'model/list':
        if (result && Array.isArray(result.data) && result.nextCursor == null) {
          return [{ to: 'client', msg: { ...msg, result: { ...result, data: this.appendModels(result.data) } } }];
        }
        return [{ to: 'client', msg }];
      case 'thread/start':
      case 'thread/startAeon':
      case 'thread/resume':
      case 'thread/fork': {
        const id = result?.thread?.id;
        const provider = result?.modelProvider ?? result?.thread?.modelProvider;
        if (typeof id === 'string' && typeof provider === 'string') this.threadProviders.set(id, provider);
        return [{ to: 'client', msg }];
      }
      case 'thread/list':
        if (Array.isArray(result?.data)) for (const t of result.data) this.observeThread(t);
        return [{ to: 'client', msg }];
      case 'thread/read':
        this.observeThread(result?.thread);
        return [{ to: 'client', msg }];
      case 'config/read':
        this.absorbConfig(result?.config);
        return [{ to: 'client', msg }];
      case 'config/batchWrite':
      case 'config/value/write':
        return [{ to: 'client', msg }, this.requestConfigRead()];
      default:
        return [{ to: 'client', msg }];
    }
  }

  private appendModels(existing: any[]): any[] {
    const state = this.deps.getState();
    const present = new Set(existing.map((m) => (typeof m?.id === 'string' ? m.id : m?.model)));
    const added: CodexModel[] = [];
    for (const m of state.models) {
      if (present.has(m.id)) continue;
      present.add(m.id);
      added.push(toCodexModel(m, state));
    }
    // Remember every model we have offered and where it is served, so a thread survives it being unloaded.
    const memory = this.deps.getMemory();
    // Before multi-provider support this was a plain list of ids; start over rather than keep its indices.
    const previous = Array.isArray(memory.knownModels) ? undefined : memory.knownModels;
    const known: Record<string, string> = { ...(previous ?? {}) };
    let changed = false;
    for (const m of state.models) {
      const key = m.id.toLowerCase();
      const provider = m.provider ?? state.providers[0]?.id;
      if (provider !== undefined && known[key] !== provider) { known[key] = provider; changed = true; }
    }
    if (changed) { memory.knownModels = known; this.deps.saveMemory(memory); }
    if (added.length > 0) this.deps.log(`model/list: appended ${added.map((m) => m.id).join(', ')}`);
    return [...existing, ...added];
  }

  private observeNotification(msg: any): void {
    switch (msg.method) {
      case 'thread/started':
        this.observeThread(msg.params?.thread);
        break;
      case 'thread/settings/updated': {
        const id = msg.params?.threadId;
        const provider = msg.params?.threadSettings?.modelProvider;
        if (typeof id === 'string' && typeof provider === 'string') this.threadProviders.set(id, provider);
        break;
      }
      default:
        break;
    }
  }

  private observeThread(thread: any): void {
    if (thread && typeof thread.id === 'string' && typeof thread.modelProvider === 'string') {
      this.threadProviders.set(thread.id, thread.modelProvider);
    }
  }

  private absorbConfig(config: any): void {
    if (!config || typeof config !== 'object') return;
    this.config = {
      model: typeof config.model === 'string' ? config.model : undefined,
      modelProvider: typeof config.model_provider === 'string' ? config.model_provider : undefined,
    };
    this.deps.log(`config: model=${this.config.model ?? '(default)'} model_provider=${this.config.modelProvider ?? '(default)'}`);
  }

  private requestConfigRead(): Action {
    const id = `${OWN_ID_PREFIX}${++this.ownSeq}`;
    this.ownPending.set(id, (response) => {
      this.absorbConfig(response?.result?.config);
      return [];
    });
    const msg: any = { id, method: 'config/read', params: { includeLayers: false } };
    if (this.useJsonRpcField) msg.jsonrpc = '2.0';
    return { to: 'server', msg };
  }

  private errorResponse(id: JsonRpcId, code: number, message: string): any {
    const msg: any = { id, error: { code, message } };
    if (this.useJsonRpcField) msg.jsonrpc = '2.0';
    return msg;
  }
}
