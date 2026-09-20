/**
 * Standalone launcher for the Claude router, for use outside VS Code
 * (e.g. `claude` in a terminal while VS Code is closed):
 *
 *   node out/claude/router-cli.js --provider http://192.168.1.128:8888/v1 [--port 41777]
 *        [--anthropic https://api.anthropic.com] [--api-key KEY] [--drop-mcp-tools] [--debug]
 *
 * --provider and --api-key may be repeated to serve several machines; the nth --api-key
 * belongs to the nth --provider. Models are read from <provider>/models (plus LM Studio /
 * Ollama metadata) every minute, exactly as the extension does, and each model is sent back
 * to the server that listed it. Then: export ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 */
import { fetchAllProviderModels, providerOrigin, ProviderSource } from '../models';
import { ClaudeRouter, ProviderTarget } from './router';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

/** Every value of a repeatable flag, in order. */
function args(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1] !== undefined) values.push(process.argv[i + 1]);
  }
  return values;
}

async function main(): Promise<void> {
  const baseUrls = args('--provider');
  if (baseUrls.length === 0) baseUrls.push(process.env.AI_PROVIDER_BASE_URL ?? 'http://localhost:1234/v1');
  const apiKeys = args('--api-key');
  const port = Number(arg('--port', process.env.AI_PROVIDER_ROUTER_PORT ?? '41777'));
  const anthropicUpstream = arg('--anthropic', 'https://api.anthropic.com')!;
  const debug = process.argv.includes('--debug');
  const exclude = (arg('--exclude', '*embed*,*rerank*,*whisper*') ?? '').split(',').filter(Boolean);

  const stamp = () => new Date().toISOString();
  const log = {
    info: (m: string) => console.log(`${stamp()} [info] ${m}`),
    debug: (m: string) => { if (debug) console.log(`${stamp()} [debug] ${m}`); },
    error: (m: string) => console.error(`${stamp()} [error] ${m}`),
  };
  const sources: ProviderSource[] = baseUrls.map((baseUrl, i) => ({
    id: String(i),
    name: providerOrigin(baseUrl),
    baseUrl,
    apiKey: apiKeys[i] ?? (baseUrls.length === 1 ? process.env.AI_PROVIDER_API_KEY : undefined),
    include: [],
    exclude,
  }));
  const targets = new Map(sources.map((s) => [s.id, { name: s.name, origin: providerOrigin(s.baseUrl), apiKey: s.apiKey }]));

  let models = new Map<string, ProviderTarget>();
  const refresh = async () => {
    const { models: found, errors } = await fetchAllProviderModels(sources, log);
    for (const e of errors) log.error(`cannot list models from ${e.baseUrl}: ${e.message}`);
    if (errors.length === sources.length) return; // every server unreachable: keep the last good list
    const next = new Map<string, ProviderTarget>();
    for (const m of found) {
      const target = m.provider !== undefined ? targets.get(m.provider) : undefined;
      if (target) next.set(m.id.trim().toLowerCase(), target);
    }
    if ([...next.keys()].join() !== [...models.keys()].join()) {
      log.info(`provider models: ${found.map((m) => m.id).join(', ') || '(none)'}`);
    }
    models = next;
  };
  await refresh();
  setInterval(refresh, 60_000).unref();

  const router = new ClaudeRouter({
    port,
    anthropicUpstream,
    resolveProvider: (m) => models.get(m.trim().toLowerCase()),
    providers: sources.map((s) => providerOrigin(s.baseUrl)),
    sanitize: { dropMcpTools: process.argv.includes('--drop-mcp-tools') },
    log,
  });
  await router.start();
  log.info(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${router.port}`);
  const stop = () => { void router.stop().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
