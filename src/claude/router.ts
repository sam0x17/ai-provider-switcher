import * as http from 'node:http';
import * as https from 'node:https';
import { AddressInfo } from 'node:net';
import { Logger, silentLogger } from '../util/log';
import { estimateTokens, sanitizeMessagesBody, SanitizeOptions } from './sanitize';

/** The server a provider model is served from. */
export interface ProviderTarget {
  /** Display name, for logs. */
  name?: string;
  /** Root of the OpenAI-compatible server without /v1, e.g. http://192.168.1.128:8888 */
  origin: string;
  apiKey?: string;
  /** Path of the Anthropic-compatible endpoint on that server (default /v1/messages). */
  messagesPath?: string;
}

export interface RouterOptions {
  port: number;
  host?: string;
  /** Where Anthropic-model traffic goes, e.g. https://api.anthropic.com */
  anthropicUpstream: string;
  /** The server that serves this model, or undefined when it is not one of ours (→ Anthropic). */
  resolveProvider(model: string): ProviderTarget | undefined;
  /** Origins of the configured servers; reported by the health endpoint for diagnostics. */
  providers?: string[];
  sanitize?: SanitizeOptions;
  log?: Logger;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

export interface RouteDecision {
  target: 'anthropic' | 'provider' | 'local-count-tokens' | 'health';
  model?: string;
  /** Set when target is 'provider'. */
  provider?: ProviderTarget;
}

export const HEALTH_PATH = '/__ai_provider_switcher/health';
export const HEALTH_SERVICE = 'ai-provider-switcher';

/** True when something answering on this port is one of our routers (e.g. from another VS Code window). */
export async function isOurRouter(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}${HEALTH_PATH}`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const json: any = await res.json();
    return json?.service === HEALTH_SERVICE;
  } catch {
    return false;
  }
}

/** Decide where a request goes. Exported for tests. */
export function decideRoute(method: string, url: string, body: Buffer, resolveProvider: (m: string) => ProviderTarget | undefined): RouteDecision {
  const path = url.split('?')[0];
  if (path === HEALTH_PATH) return { target: 'health' };
  if (method !== 'POST' || !path.startsWith('/v1/messages')) return { target: 'anthropic' };
  let model: string | undefined;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (typeof parsed?.model === 'string') model = parsed.model;
  } catch {
    return { target: 'anthropic' };
  }
  const provider = model === undefined ? undefined : resolveProvider(model);
  if (provider === undefined) return { target: 'anthropic', model };
  if (path === '/v1/messages/count_tokens') return { target: 'local-count-tokens', model };
  return { target: 'provider', model, provider };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function anthropicError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

export class ClaudeRouter {
  private server: http.Server | undefined;
  private readonly log: Logger;

  constructor(private readonly options: RouterOptions) {
    this.log = options.log ?? silentLogger;
  }

  get port(): number {
    const addr = this.server?.address() as AddressInfo | null | undefined;
    return addr?.port ?? this.options.port;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log.error(`router: ${(e as Error).stack ?? e}`);
        if (!res.headersSent) anthropicError(res, 502, `AI Provider Switcher router error: ${(e as Error).message}`);
        else res.end();
      });
    });
    // Local models can take minutes to process a long prompt; never time out.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.log.info(`router listening on http://${this.options.host ?? '127.0.0.1'}:${this.port}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    req.setTimeout(0);
    const body = await readBody(req);
    const decision = decideRoute(req.method ?? 'GET', req.url ?? '/', body, this.options.resolveProvider);

    if (decision.target === 'health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: HEALTH_SERVICE, pid: process.pid, providers: this.options.providers ?? [], anthropic: this.options.anthropicUpstream }));
      return;
    }

    if (decision.target === 'local-count-tokens') {
      let parsed: any = {};
      try { parsed = JSON.parse(body.toString('utf8')); } catch { /* ignore */ }
      const input_tokens = estimateTokens(parsed);
      this.log.debug(`count_tokens for ${decision.model} answered locally (~${input_tokens})`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens }));
      return;
    }

    let upstreamBase: string;
    let path = req.url ?? '/';
    let outBody = body;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = v;
    }

    if (decision.target === 'provider') {
      const provider = decision.provider!;
      upstreamBase = provider.origin;
      const [, query] = (req.url ?? '/').split('?');
      path = (provider.messagesPath ?? '/v1/messages') + (query ? `?${query}` : '');
      // Never leak Anthropic credentials to the third-party server.
      delete headers.authorization;
      delete headers['x-api-key'];
      delete headers['anthropic-beta'];
      if (provider.apiKey) {
        headers.authorization = `Bearer ${provider.apiKey}`;
        headers['x-api-key'] = provider.apiKey;
      }
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        outBody = Buffer.from(JSON.stringify(sanitizeMessagesBody(parsed, this.options.sanitize)));
      } catch {
        // leave body as-is
      }
      // The provider may not compress; ask for identity so we can pipe bytes through untouched.
      headers['accept-encoding'] = 'identity';
    } else {
      upstreamBase = this.options.anthropicUpstream;
    }

    const url = new URL(path, upstreamBase);
    headers.host = url.host;
    headers['content-length'] = String(outBody.length);
    const name = decision.provider?.name;
    const via = name && name !== url.origin ? `${name} ${url.origin}` : url.origin;
    this.log.debug(`${req.method} ${req.url} model=${decision.model ?? '-'} -> ${decision.target} (${via})`);

    const transport = url.protocol === 'https:' ? https : http;
    await new Promise<void>((resolve) => {
      const upstream = transport.request(url, { method: req.method, headers }, (up) => {
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined || k === 'connection' || k === 'keep-alive' || k === 'transfer-encoding') continue;
          responseHeaders[k] = v;
        }
        if (decision.target === 'provider' && up.statusCode && up.statusCode >= 400) {
          const chunks: Buffer[] = [];
          up.on('data', (c: Buffer) => chunks.push(c));
          up.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            this.log.error(`provider returned ${up.statusCode} for ${decision.model}: ${text.slice(0, 1000)}`);
            res.writeHead(up.statusCode ?? 502, responseHeaders);
            res.end(text);
            resolve();
          });
          return;
        }
        res.writeHead(up.statusCode ?? 502, responseHeaders);
        up.pipe(res);
        up.on('end', resolve);
        up.on('error', () => { res.end(); resolve(); });
      });
      upstream.setTimeout(0);
      upstream.on('error', (e) => {
        this.log.error(`upstream ${url.origin} error: ${e.message}`);
        if (!res.headersSent) anthropicError(res, 502, `AI Provider Switcher could not reach ${url.origin}: ${e.message}`);
        else res.end();
        resolve();
      });
      req.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end(outBody);
    });
  }
}
