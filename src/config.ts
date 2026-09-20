import * as vscode from 'vscode';

/** One OpenAI-compatible server. Several may be configured; every model carries the id of the one it came from. */
export interface ProviderConfig {
  /** Stable, Codex-safe id: the `model_providers` key and the tag on this server's models. */
  id: string;
  name: string;
  /** e.g. http://192.168.1.128:8888/v1 */
  baseUrl: string;
  apiKey: string;
  include: string[];
  exclude: string[];
}

export interface SwitcherSettings {
  enabled: boolean;
  providers: ProviderConfig[];
  refreshMinutes: number;
  claude: {
    enabled: boolean;
    routerPort: number;
    anthropicUpstream: string;
    behavesAs: string;
    replaceBuiltInModels: boolean;
    dropMcpTools: boolean;
  };
  codex: {
    enabled: boolean;
    providerId: string;
    reasoningEfforts: string[];
    writeConfigToml: boolean;
  };
  debug: boolean;
}

export const SECTION = 'aiProviderSwitcher';

/** Codex ships these; reusing one would shadow its own definition. */
const BUILT_IN_CODEX_PROVIDERS = new Set([
  'openai', 'azure', 'openrouter', 'ollama', 'lmstudio', 'mistral', 'deepseek', 'xai', 'groq', 'arceeai', 'baseten',
]);

export function sanitizeProviderId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, '');
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function readSettings(): SwitcherSettings {
  const c = vscode.workspace.getConfiguration(SECTION);
  const str = (key: string, fallback: string) => {
    const v = c.get<string>(key);
    return typeof v === 'string' ? v : fallback;
  };
  const list = (key: string, fallback: string[]) => {
    const v = c.get<string[]>(key);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : fallback;
  };
  const include = list('models.include', []);
  const exclude = list('models.exclude', ['*embed*', '*rerank*', '*whisper*']);
  const codexProviderId = sanitizeProviderId(str('codex.providerId', 'aiswitch')) || 'aiswitch';

  return {
    enabled: c.get<boolean>('enabled', true),
    providers: readProviders(c, { include, exclude, codexProviderId }),
    refreshMinutes: c.get<number>('models.refreshMinutes', 10),
    claude: {
      enabled: c.get<boolean>('claude.enabled', true),
      routerPort: c.get<number>('claude.routerPort', 41777),
      anthropicUpstream: str('claude.anthropicUpstream', 'https://api.anthropic.com'),
      behavesAs: str('claude.behavesAs', 'claude-sonnet-4-6'),
      replaceBuiltInModels: c.get<boolean>('claude.replaceBuiltInModels', false),
      dropMcpTools: c.get<boolean>('claude.dropMcpTools', false),
    },
    codex: {
      enabled: c.get<boolean>('codex.enabled', true),
      providerId: codexProviderId,
      reasoningEfforts: list('codex.reasoningEfforts', ['low', 'medium', 'high']),
      writeConfigToml: c.get<boolean>('codex.writeConfigToml', true),
    },
    debug: c.get<boolean>('debug', false),
  };
}

interface Defaults {
  include: string[];
  exclude: string[];
  codexProviderId: string;
}

function readProviders(c: vscode.WorkspaceConfiguration, defaults: Defaults): ProviderConfig[] {
  const raw = c.get<unknown>('providers');
  const entries = Array.isArray(raw) ? raw.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object') : [];
  if (entries.length === 0) {
    // No list configured: the single-server settings are the provider (how every install before 0.2 was set up).
    return normalizeProviders([{
      name: (c.get<string>('providerName') ?? 'LM Studio') || 'Local',
      baseUrl: c.get<string>('baseUrl') ?? 'http://localhost:1234/v1',
      apiKey: c.get<string>('apiKey') ?? '',
      id: defaults.codexProviderId,
    }], defaults);
  }
  return normalizeProviders(entries.map((e, i) => ({
    name: typeof e.name === 'string' && e.name.trim() !== '' ? e.name.trim() : `Provider ${i + 1}`,
    baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : '',
    apiKey: typeof e.apiKey === 'string' ? e.apiKey : '',
    id: typeof e.codexProviderId === 'string' ? sanitizeProviderId(e.codexProviderId) : '',
    include: Array.isArray(e.include) ? e.include.filter((x): x is string => typeof x === 'string') : undefined,
    exclude: Array.isArray(e.exclude) ? e.exclude.filter((x): x is string => typeof x === 'string') : undefined,
  })), defaults);
}

interface RawProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  id: string;
  include?: string[];
  exclude?: string[];
}

function normalizeProviders(raw: RawProvider[], defaults: Defaults): ProviderConfig[] {
  const used = new Set<string>();
  const providers: ProviderConfig[] = [];
  for (const entry of raw) {
    if (entry.baseUrl.trim() === '') continue;
    let id = entry.id;
    // An id derived from the name is prefixed so it can never collide with a provider Codex defines itself.
    if (id === '' || BUILT_IN_CODEX_PROVIDERS.has(id.toLowerCase())) {
      const derived = slug(entry.name);
      id = derived === '' ? defaults.codexProviderId : `${defaults.codexProviderId}-${derived}`;
    }
    let unique = id;
    for (let n = 2; used.has(unique); n++) unique = `${id}-${n}`;
    used.add(unique);
    providers.push({
      id: unique,
      name: entry.name,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      include: entry.include ?? defaults.include,
      exclude: entry.exclude ?? defaults.exclude,
    });
  }
  return providers;
}

/** Label for the status bar and notifications. */
export function providersLabel(providers: readonly ProviderConfig[]): string {
  if (providers.length === 0) return 'no provider';
  if (providers.length === 1) return providers[0].name;
  return `${providers.length} providers`;
}
