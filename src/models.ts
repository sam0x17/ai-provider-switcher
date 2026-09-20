import { matchesAny } from './util/glob';
import { Logger, prefixed, silentLogger } from './util/log';

/** A model offered by the OpenAI-compatible server, with whatever extra detail the server exposes. */
export interface ProviderModel {
  id: string;
  /** llm | vlm | embeddings | … (LM Studio) */
  type?: string;
  contextLength?: number;
  loaded?: boolean;
  publisher?: string;
  quantization?: string;
  arch?: string;
  parameterSize?: string;
  vision?: boolean;
  toolUse?: boolean;
  /** Id of the provider this model came from; set when several servers are configured. */
  provider?: string;
  /** That provider's display name, carried along so pickers can label a model without a lookup. */
  providerName?: string;
}

export interface ModelSource {
  /** e.g. http://192.168.1.128:8888/v1 */
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Stamped onto every model the source returns. */
  id?: string;
  name?: string;
}

/** Normalise the base URL: no trailing slash. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Origin-ish root of the server without the /v1 suffix (http://host:port). */
export function providerOrigin(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v\d+$/i, '');
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey } : {};
}

async function getJson(url: string, apiKey: string | undefined, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...authHeaders(apiKey) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * Metadata some servers (llama.cpp behind a model swapper, vLLM, …) put straight into
 * /v1/models. `context_length` is what the model is served with right now and wins over the
 * `max_/native_` ceilings, so the pickers never promise a longer window than the server has.
 */
function listedModel(id: string, entry: any): ProviderModel {
  const model: ProviderModel = { id };
  const context = num(entry?.context_length) ?? num(entry?.max_context_length) ?? num(entry?.native_context_length) ?? num(entry?.max_model_len);
  if (context !== undefined) model.contextLength = context;
  if (typeof entry?.loaded === 'boolean') model.loaded = entry.loaded;
  const quantization = str(entry?.quant) ?? str(entry?.quantization);
  if (quantization !== undefined) model.quantization = quantization;
  const type = str(entry?.type);
  if (type !== undefined) model.type = type;
  if (entry?.modalities?.vision === true) model.vision = true;
  return model;
}

/**
 * Fetch the model list from <baseUrl>/models and enrich it from
 * LM Studio (/api/v0/models) or Ollama (/api/tags) when those respond.
 */
export async function fetchProviderModels(src: ModelSource, log: Logger = silentLogger): Promise<ProviderModel[]> {
  const base = normalizeBaseUrl(src.baseUrl);
  const origin = providerOrigin(base);
  const timeout = src.timeoutMs ?? 8000;

  const list = await getJson(`${base}/models`, src.apiKey, timeout);
  const data: any[] = Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : [];
  const models = new Map<string, ProviderModel>();
  for (const entry of data) {
    const id = typeof entry?.id === 'string' ? entry.id : typeof entry?.name === 'string' ? entry.name : undefined;
    if (id) models.set(id, listedModel(id, entry));
  }

  // LM Studio REST API: richer metadata (type, context length, load state, capabilities).
  try {
    const lm = await getJson(`${origin}/api/v0/models`, src.apiKey, timeout);
    if (Array.isArray(lm?.data)) {
      for (const m of lm.data) {
        if (typeof m?.id !== 'string') continue;
        const target: ProviderModel = models.get(m.id) ?? { id: m.id };
        target.type = typeof m.type === 'string' ? m.type : target.type;
        target.contextLength = typeof m.max_context_length === 'number' ? m.max_context_length : target.contextLength;
        target.loaded = m.state === 'loaded';
        target.publisher = typeof m.publisher === 'string' ? m.publisher : target.publisher;
        target.quantization = typeof m.quantization === 'string' ? m.quantization : target.quantization;
        target.arch = typeof m.arch === 'string' ? m.arch : target.arch;
        target.vision = m.type === 'vlm' || target.vision;
        target.toolUse = Array.isArray(m.capabilities) ? m.capabilities.includes('tool_use') : target.toolUse;
        models.set(m.id, target);
      }
      log.debug(`LM Studio metadata merged for ${lm.data.length} models`);
    }
  } catch (e) {
    log.debug(`no LM Studio metadata (${(e as Error).message})`);
  }

  // Ollama: /api/tags exposes family, parameter size and quantization.
  try {
    const ol = await getJson(`${origin}/api/tags`, src.apiKey, timeout);
    if (Array.isArray(ol?.models)) {
      for (const m of ol.models) {
        const name = typeof m?.name === 'string' ? m.name : typeof m?.model === 'string' ? m.model : undefined;
        if (!name) continue;
        const target: ProviderModel = models.get(name) ?? { id: name };
        target.arch = m.details?.family ?? target.arch;
        target.parameterSize = m.details?.parameter_size ?? target.parameterSize;
        target.quantization = m.details?.quantization_level ?? target.quantization;
        models.set(name, target);
      }
      log.debug(`Ollama metadata merged for ${ol.models.length} models`);
    }
  } catch (e) {
    log.debug(`no Ollama metadata (${(e as Error).message})`);
  }

  const result = [...models.values()];
  if (src.id !== undefined || src.name !== undefined) {
    for (const m of result) {
      if (src.id !== undefined) m.provider = src.id;
      if (src.name !== undefined) m.providerName = src.name;
    }
  }
  // Loaded models first, otherwise keep server order.
  return result.sort((a, b) => Number(b.loaded === true) - Number(a.loaded === true));
}

export interface ModelFilter {
  include: readonly string[];
  exclude: readonly string[];
}

export function filterModels(models: readonly ProviderModel[], filter: ModelFilter): ProviderModel[] {
  return models.filter((m) => {
    if (m.type === 'embeddings' || m.type === 'embedding') return false;
    if (filter.include.length > 0 && !matchesAny(m.id, filter.include)) return false;
    if (matchesAny(m.id, filter.exclude)) return false;
    return true;
  });
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return String(tokens);
}

/** One-line human description used by both pickers. */
export function describeModel(m: ProviderModel, providerName = ''): string {
  const label = m.providerName ?? providerName;
  const parts: string[] = label === '' ? [] : [label];
  if (m.publisher) parts.push(m.publisher);
  if (m.parameterSize) parts.push(m.parameterSize);
  if (m.quantization) parts.push(m.quantization);
  if (m.contextLength) parts.push(`${formatContext(m.contextLength)} context`);
  if (m.vision) parts.push('vision');
  if (m.loaded === true) parts.push('loaded');
  return parts.join(' · ');
}

export interface ProviderSource extends ModelSource {
  id: string;
  name: string;
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface MultiFetchResult {
  models: ProviderModel[];
  /** One entry per source that could not be listed, in source order. */
  errors: Array<{ id: string; name: string; baseUrl: string; message: string }>;
}

/**
 * List every configured server in parallel and merge the results. Sources are queried
 * concurrently but merged in configuration order, and the first server offering a model id
 * keeps it — two servers exposing the same id would otherwise be indistinguishable in a picker.
 */
export async function fetchAllProviderModels(sources: readonly ProviderSource[], log: Logger = silentLogger): Promise<MultiFetchResult> {
  const settled = await Promise.all(sources.map(async (src) => {
    try {
      const all = await fetchProviderModels(src, prefixed(log, `[${src.name}]`));
      return { src, models: filterModels(all, { include: src.include ?? [], exclude: src.exclude ?? [] }) };
    } catch (e) {
      return { src, error: (e as Error).message };
    }
  }));

  const models: ProviderModel[] = [];
  const errors: MultiFetchResult['errors'] = [];
  const seen = new Set<string>();
  for (const entry of settled) {
    if ('error' in entry && entry.error !== undefined) {
      errors.push({ id: entry.src.id, name: entry.src.name, baseUrl: entry.src.baseUrl, message: entry.error });
      continue;
    }
    for (const m of entry.models ?? []) {
      const key = m.id.toLowerCase();
      if (seen.has(key)) {
        log.info(`${entry.src.name}: ignoring ${m.id}, another provider already offers that id`);
        continue;
      }
      seen.add(key);
      models.push(m);
    }
  }
  return { models, errors };
}
