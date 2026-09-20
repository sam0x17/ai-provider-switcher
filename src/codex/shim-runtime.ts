/**
 * Stand-in for the Codex CLI. The Codex extension is pointed at this script
 * (via chatgpt.cliExecutable). For everything except `app-server` it simply runs
 * the real bundled binary. For `app-server` it runs the real binary too, but sits
 * on its stdio JSON-RPC stream so the model picker gains the provider's models and
 * threads that use them are bound to the provider's model_providers entry.
 *
 * Usage: node shim-runtime.js <codex args...>   (state file via AI_PROVIDER_SWITCHER_STATE)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fetchAllProviderModels, ProviderSource } from '../models';
import { providerOverrides } from './config';
import { findBundledCodex } from './find-codex';
import { RpcRewriter } from './rpc-rewrite';
import { ShimMemory, ShimState } from './state';

const statePath = process.env.AI_PROVIDER_SWITCHER_STATE ?? '';
const stateDir = statePath ? path.dirname(statePath) : process.cwd();
const memoryPath = path.join(stateDir, 'memory.json');
const logPath = path.join(stateDir, 'shim.log');

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

let state: ShimState = readJson<ShimState>(statePath, { providers: [], models: [], reasoningEfforts: [] });
let stateMtime = 0;
try { stateMtime = fs.statSync(statePath).mtimeMs; } catch { /* no state file */ }

function log(message: string): void {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2_000_000) fs.truncateSync(logPath, 0);
    fs.appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {
    /* logging is best effort */
  }
}

function refreshState(): void {
  try {
    const mtime = fs.statSync(statePath).mtimeMs;
    if (mtime !== stateMtime) {
      stateMtime = mtime;
      state = readJson(statePath, state);
      log(`state reloaded (${state.models.length} models)`);
    }
  } catch {
    /* keep current state */
  }
}

const args = process.argv.slice(2);
const realCodex: string = findBundledCodex(state.realCodexHint) ?? missingCodex();

function missingCodex(): never {
  process.stderr.write('AI Provider Switcher: could not locate the bundled Codex CLI. Clear the chatgpt.cliExecutable setting to recover.\n');
  process.exit(127);
}

const env = { ...process.env };
// Never let the real CLI (or anything it launches, such as the `code` CLI) inherit our Node trick.
delete env.ELECTRON_RUN_AS_NODE;
delete env.AI_PROVIDER_SWITCHER_STATE;
for (const provider of state.providers) if (provider.apiKey) env[provider.apiKeyEnv] = provider.apiKey;

const appServerIndex = args.indexOf('app-server');
if (appServerIndex === -1) {
  // Plain pass-through (codex --version, codex login, ...).
  const child = spawn(realCodex, args, { stdio: 'inherit', env });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGHUP', forward('SIGHUP'));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', (e) => { process.stderr.write(`AI Provider Switcher: ${e.message}\n`); process.exit(126); });
} else {
  runAppServer(appServerIndex);
}

function runAppServer(appServerIndex: number): void {
  const overrides = state.providers.flatMap((provider) => providerOverrides({
    providerId: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKey ? provider.apiKeyEnv : undefined,
  }));
  const fullArgs = [...args.slice(0, appServerIndex), ...overrides, ...args.slice(appServerIndex)];
  log(`starting ${realCodex} ${fullArgs.join(' ')}`);

  const child = spawn(realCodex, fullArgs, { stdio: ['pipe', 'pipe', 'inherit'] as const, env });

  const rewriter = new RpcRewriter({
    getState: () => { refreshState(); return state; },
    getMemory: () => readJson<ShimMemory>(memoryPath, {}),
    saveMemory: (memory) => { try { fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2)); } catch { /* ignore */ } },
    log: (m) => log(m),
  });

  const writeTo = (to: 'server' | 'client', msg: any) => {
    const line = JSON.stringify(msg) + '\n';
    if (to === 'server') child.stdin.write(line);
    else process.stdout.write(line);
  };

  const pump = (source: NodeJS.ReadableStream, direction: 'toServer' | 'toClient') => {
    let buffer = '';
    source.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        handleLine(line, direction);
      }
    });
    source.on('end', () => {
      if (buffer.trim() !== '') handleLine(buffer, direction);
      if (direction === 'toServer') child.stdin.end();
    });
  };

  const handleLine = (line: string, direction: 'toServer' | 'toClient') => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not JSON (unlikely): forward verbatim.
      if (direction === 'toServer') child.stdin.write(line + '\n');
      else process.stdout.write(line + '\n');
      return;
    }
    let actions;
    try {
      actions = direction === 'toServer' ? rewriter.fromClient(msg) : rewriter.fromServer(msg);
    } catch (e) {
      log(`rewrite error: ${(e as Error).stack ?? e}`);
      actions = [{ to: direction === 'toServer' ? 'server' : 'client', msg }] as const;
    }
    if (state.debug) log(`${direction === 'toServer' ? '>>' : '<<'} ${line.slice(0, 400)}`);
    for (const action of actions) writeTo(action.to, action.msg);
  };

  pump(process.stdin, 'toServer');
  pump(child.stdout, 'toClient');

  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGHUP', forward('SIGHUP'));
  child.on('exit', (code, signal) => {
    log(`app-server exited code=${code} signal=${signal}`);
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on('error', (e) => {
    log(`spawn error: ${e.message}`);
    process.stderr.write(`AI Provider Switcher: failed to start Codex: ${e.message}\n`);
    process.exit(126);
  });

  // Keep the picker fresh while the app-server lives: re-read every server's model list periodically.
  const refreshModels = async () => {
    const filters = readJson<Record<string, { include: string[]; exclude: string[] }>>(path.join(stateDir, 'filter.json'), {});
    const sources: ProviderSource[] = state.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      include: filters[p.id]?.include ?? [],
      exclude: filters[p.id]?.exclude ?? [],
    }));
    const { models, errors } = await fetchAllProviderModels(sources);
    for (const e of errors) log(`model refresh failed for ${e.name} (${e.baseUrl}): ${e.message}`);
    // A server that is merely unreachable must not empty the picker.
    if (errors.length === sources.length && sources.length > 0) return;
    if (JSON.stringify(models) !== JSON.stringify(state.models)) {
      state = { ...state, models };
      log(`models refreshed: ${models.map((m) => m.id).join(', ') || '(none)'}`);
    }
  };
  const timer = setInterval(refreshModels, 60_000);
  timer.unref();
}
