import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildModelPicker,
  buildPickerRows,
  claudeSettingsPath,
  readSettingsJson,
  samePicker,
  writeSettingsJson,
} from './claude/settings';
import { ClaudeRouter, isOurRouter, ProviderTarget } from './claude/router';
import { codexConfigPath, removeProviderFromConfig, writeProviderToConfig } from './codex/config';
import { codexBinaryInExtension } from './codex/find-codex';
import { apiKeyEnvName, ShimState } from './codex/state';
import { ProviderConfig, providersLabel, readSettings, SECTION, SwitcherSettings } from './config';
import { describeModel, fetchAllProviderModels, normalizeBaseUrl, ProviderModel, providerOrigin } from './models';
import { writeFileAtomic } from './util/fs';
import { Logger } from './util/log';

const CODEX_EXTENSION_ID = 'openai.chatgpt';
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_ENV_NAME = 'ANTHROPIC_BASE_URL';
/** Local models can take many minutes before the first token; raise Claude Code's per-request timeout. */
const CLAUDE_TIMEOUT_ENV = 'API_TIMEOUT_MS';
const CLAUDE_TIMEOUT_VALUE = String(60 * 60 * 1000);

/** Keys stored in globalState so a later run (or Disable) can undo what we changed. */
const KEYS = {
  claudePreviousPicker: 'claude.previousModelPicker',
  claudeLastWrittenPicker: 'claude.lastWrittenModelPicker',
  claudePreviousBaseUrl: 'claude.previousBaseUrl',
  claudeManagedBaseUrl: 'claude.managedBaseUrl',
  claudeManagedTimeout: 'claude.managedTimeout',
  codexPreviousCli: 'codex.previousCliExecutable',
  codexManagedCli: 'codex.managedCliExecutable',
  codexManagedProviderIds: 'codex.managedProviderIds',
  modelsCache: 'models.cache',
  knownModels: 'models.known',
} as const;

interface EnvEntry {
  name: string;
  value: string;
}

class Switcher {
  private readonly output = vscode.window.createOutputChannel('AI Provider Switcher');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  private router: ClaudeRouter | undefined;
  private routerKey = '';
  /** The router is currently provided by another VS Code window. */
  private routerShared = false;
  private routerWatch: NodeJS.Timeout | undefined;
  private routerOptions: { settings: SwitcherSettings; upstream: string } | undefined;
  private models: ProviderModel[] = [];
  /** Configured servers by id, so a model can be traced back to the one serving it. */
  private providersById = new Map<string, ProviderConfig>();
  private lastError: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private applying: Promise<void> = Promise.resolve();
  private debug = false;
  readonly log: Logger = {
    info: (m) => this.output.appendLine(`${new Date().toISOString()} [info] ${m}`),
    debug: (m) => { if (this.debug) this.output.appendLine(`${new Date().toISOString()} [debug] ${m}`); },
    error: (m) => this.output.appendLine(`${new Date().toISOString()} [error] ${m}`),
  };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.command = 'aiProviderSwitcher.showModels';
    this.models = context.globalState.get<ProviderModel[]>(KEYS.modelsCache, []);
    context.subscriptions.push(this.output, this.status);
  }

  // ------------------------------------------------------------------ lifecycle

  activate(): void {
    const c = this.context;
    c.subscriptions.push(
      vscode.commands.registerCommand('aiProviderSwitcher.refresh', () => this.refreshCommand()),
      vscode.commands.registerCommand('aiProviderSwitcher.enable', () => this.setEnabled(true)),
      vscode.commands.registerCommand('aiProviderSwitcher.disable', () => this.setEnabled(false)),
      vscode.commands.registerCommand('aiProviderSwitcher.showModels', () => this.showModels()),
      vscode.commands.registerCommand('aiProviderSwitcher.showLog', () => this.output.show(true)),
      vscode.commands.registerCommand('aiProviderSwitcher.openSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${c.extension.id}`)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) void this.queue(() => this.sync('settings changed'));
      }),
    );
    void this.queue(() => this.sync('startup'));
  }

  async deactivate(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.routerWatch) clearInterval(this.routerWatch);
    await this.router?.stop();
  }

  private queue(task: () => Promise<void>): Promise<void> {
    this.applying = this.applying.then(task, task).catch((e) => {
      this.log.error(`${(e as Error).stack ?? e}`);
      void vscode.window.showErrorMessage(`AI Provider Switcher: ${(e as Error).message}`);
    });
    return this.applying;
  }

  // ------------------------------------------------------------------ commands

  private async refreshCommand(): Promise<void> {
    await this.queue(() => this.sync('manual refresh'));
    const settings = readSettings();
    if (!settings.enabled) {
      void vscode.window.showInformationMessage('AI Provider Switcher is disabled. Run "AI Provider Switcher: Enable" first.');
    } else if (this.lastError) {
      void vscode.window.showWarningMessage(`AI Provider Switcher: ${this.lastError}`);
    } else {
      void vscode.window.showInformationMessage(
        `AI Provider Switcher: ${this.models.length} model${this.models.length === 1 ? '' : 's'} from ${providersLabel(settings.providers)} offered to Codex and Claude Code.`);
    }
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update('enabled', enabled, vscode.ConfigurationTarget.Global);
    // onDidChangeConfiguration performs the sync.
  }

  private async showModels(): Promise<void> {
    const settings = readSettings();
    const items: vscode.QuickPickItem[] = this.models.map((m) => ({ label: m.id, description: describeModel(m) }));
    if (items.length === 0) {
      items.push({
        label: this.lastError ? `$(warning) ${this.lastError}` : '$(info) No models offered',
        description: settings.providers.map((p) => normalizeBaseUrl(p.baseUrl)).join(', '),
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: `AI Provider Switcher — ${settings.providers.map((p) => `${p.name} (${normalizeBaseUrl(p.baseUrl)})`).join('  ·  ')}`,
      placeHolder: 'Models currently offered in the Codex and Claude Code pickers (Enter copies the id)',
    });
    if (picked && this.models.some((m) => m.id === picked.label)) {
      await vscode.env.clipboard.writeText(picked.label);
      void vscode.window.setStatusBarMessage(`Copied ${picked.label}`, 3000);
    }
  }

  // ------------------------------------------------------------------ core sync

  private async sync(reason: string): Promise<void> {
    const settings = readSettings();
    this.debug = settings.debug;
    this.providersById = new Map(settings.providers.map((p) => [p.id, p]));
    this.log.info(`sync (${reason}): enabled=${settings.enabled} providers=${
      settings.providers.map((p) => `${p.id}@${normalizeBaseUrl(p.baseUrl)}`).join(' ') || '(none configured)'}`);

    if (!settings.enabled) {
      await this.revertAll(settings);
      this.updateStatus(settings, false);
      return;
    }

    await this.loadModels(settings);

    // The two integrations are independent: a failure in one must not block the other.
    let needsReload = false;
    const failures: string[] = [];
    try {
      if (settings.claude.enabled) await this.applyClaude(settings);
      else await this.revertClaude();
    } catch (e) {
      failures.push(`Claude Code: ${describeError(e, settings)}`);
      this.log.error(`Claude: ${(e as Error).stack ?? e}`);
    }
    try {
      if (settings.codex.enabled) needsReload = (await this.applyCodex(settings)) || needsReload;
      else needsReload = (await this.revertCodex()) || needsReload;
    } catch (e) {
      failures.push(`Codex: ${(e as Error).message}`);
      this.log.error(`Codex: ${(e as Error).stack ?? e}`);
    }

    this.scheduleRefresh(settings);
    this.updateStatus(settings, true);
    if (failures.length > 0) {
      const choice = await vscode.window.showErrorMessage(`AI Provider Switcher: ${failures.join(' — ')}`, 'Show Log');
      if (choice === 'Show Log') this.output.show(true);
    }

    if (needsReload) {
      this.log.info('Codex must be restarted (reload the window) to pick up the CLI wrapper');
      if (vscode.window.state.focused) {
        const choice = await vscode.window.showInformationMessage(
          'AI Provider Switcher: Codex now launches through the switcher. Reload the window so the Codex extension restarts its app-server.',
          'Reload Window', 'Later');
        if (choice === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }
  }

  private async loadModels(settings: SwitcherSettings): Promise<void> {
    if (settings.providers.length === 0) {
      this.models = [];
      this.lastError = 'no provider configured (set aiProviderSwitcher.providers or aiProviderSwitcher.baseUrl)';
      this.log.error(this.lastError);
      return;
    }
    const { models, errors } = await fetchAllProviderModels(settings.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey || undefined,
      include: p.include,
      exclude: p.exclude,
    })), this.log);

    this.lastError = errors.length === 0 ? undefined
      : errors.map((e) => `cannot list models from ${e.name} (${normalizeBaseUrl(e.baseUrl)}): ${e.message}`).join('; ');
    if (this.lastError) this.log.error(this.lastError);
    // A server that is down must not wipe the models the reachable ones still offer.
    if (errors.length === settings.providers.length) return;

    this.models = models;
    const known = this.knownModels();
    for (const m of models) if (m.provider) known[m.id.toLowerCase()] = m.provider;
    await this.context.globalState.update(KEYS.knownModels, known);
    await this.context.globalState.update(KEYS.modelsCache, models);
    this.log.info(`models offered: ${models.map((m) => `${m.id} (${m.providerName ?? m.provider})`).join(', ') || '(none after filtering)'}`);
  }

  /** Lowercased model id → provider id, for models that are no longer listed (unloaded, server down). */
  private knownModels(): Record<string, string> {
    const raw = this.context.globalState.get<unknown>(KEYS.knownModels);
    const first = this.providersById.keys().next();
    if (Array.isArray(raw)) {
      // Pre-multi-provider installs stored a plain list of ids; they all came from the one provider.
      const migrated: Record<string, string> = {};
      if (!first.done) for (const id of raw) if (typeof id === 'string') migrated[id.toLowerCase()] = first.value;
      return migrated;
    }
    return raw && typeof raw === 'object' ? { ...(raw as Record<string, string>) } : {};
  }

  private scheduleRefresh(settings: SwitcherSettings): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (settings.refreshMinutes > 0) {
      this.timer = setInterval(() => void this.queue(() => this.sync('periodic refresh')), settings.refreshMinutes * 60_000);
    }
  }

  private updateStatus(settings: SwitcherSettings, enabled: boolean): void {
    const name = providersLabel(settings.providers);
    if (!enabled) {
      this.status.text = `$(circle-slash) ${name}`;
      this.status.tooltip = 'AI Provider Switcher is disabled';
    } else if (this.lastError) {
      this.status.text = `$(warning) ${name}: ${this.models.length}`;
      this.status.tooltip = `AI Provider Switcher — ${this.lastError}\n(${this.models.length} cached models still offered)`;
    } else {
      this.status.text = `$(server) ${name}: ${this.models.length}`;
      const lines = [
        ...settings.providers.map((p) => `AI Provider Switcher — ${p.name}: ${normalizeBaseUrl(p.baseUrl)}`),
        ...this.models.map((m) => {
          const from = m.providerName ?? m.provider;
          return `• ${m.id}${settings.providers.length > 1 && from ? ` (${from})` : ''}`;
        }),
      ];
      if (this.router) lines.push(`Claude router: http://127.0.0.1:${this.router.port}`);
      else if (this.routerShared) lines.push(`Claude router: http://127.0.0.1:${settings.claude.routerPort} (running in another window)`);
      this.status.tooltip = lines.join('\n');
    }
    this.status.show();
  }

  /** The server serving this model, or undefined when the request belongs to Anthropic. */
  resolveProvider(model: string): ProviderTarget | undefined {
    const wanted = model.trim().toLowerCase();
    const id = this.models.find((m) => m.id.toLowerCase() === wanted)?.provider ?? this.knownModels()[wanted];
    if (id === undefined) return undefined;
    const provider = this.providersById.get(id);
    if (provider === undefined) {
      this.log.debug(`model ${model} came from provider ${id}, which is no longer configured`);
      return undefined;
    }
    return { name: provider.name, origin: providerOrigin(provider.baseUrl), apiKey: provider.apiKey || undefined };
  }

  private async revertAll(settings: SwitcherSettings): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.revertClaude();
    const needsReload = await this.revertCodex();
    if (needsReload) {
      const choice = await vscode.window.showInformationMessage(
        'AI Provider Switcher: Codex settings restored. Reload the window so the Codex extension restarts with its own CLI.',
        'Reload Window', 'Later');
      if (choice === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    this.log.info(`disabled; Codex providers ${settings.providers.map((p) => p.id).join(', ') || '(none)'} and Claude picker entries removed`);
  }

  // ------------------------------------------------------------------ Claude Code

  private claudeEnv(): { config: vscode.WorkspaceConfiguration; entries: EnvEntry[] } {
    const config = vscode.workspace.getConfiguration('claudeCode');
    const raw = config.inspect<EnvEntry[]>('environmentVariables')?.globalValue;
    const entries = Array.isArray(raw) ? raw.filter((e) => e && typeof e.name === 'string') : [];
    return { config, entries };
  }

  private async applyClaude(settings: SwitcherSettings): Promise<void> {
    const state = this.context.globalState;
    const ourUrl = `http://127.0.0.1:${settings.claude.routerPort}`;

    // 1. Work out the Anthropic upstream: honour a pre-existing ANTHROPIC_BASE_URL (e.g. an enterprise gateway).
    const { config: claudeConfig, entries } = this.claudeEnv();
    const existing = entries.find((e) => e.name === CLAUDE_ENV_NAME);
    const managed = state.get<string>(KEYS.claudeManagedBaseUrl);
    if (existing && existing.value !== ourUrl && existing.value !== managed) {
      await state.update(KEYS.claudePreviousBaseUrl, existing.value);
      this.log.info(`Claude: remembering previous ${CLAUDE_ENV_NAME}=${existing.value}`);
    }
    const previous = state.get<string>(KEYS.claudePreviousBaseUrl);
    const upstream = previous && settings.claude.anthropicUpstream === 'https://api.anthropic.com' ? previous : settings.claude.anthropicUpstream;

    // 2. Router (one per machine: other VS Code windows share it and take over when it goes away).
    await this.ensureRouter(settings, upstream);

    // 3. Picker rows in ~/.claude/settings.json.
    const file = claudeSettingsPath();
    const json = readSettingsJson(file);
    const lastWritten = state.get<unknown>(KEYS.claudeLastWrittenPicker);
    if (json.modelPicker !== undefined && !samePicker(json.modelPicker, lastWritten)) {
      await state.update(KEYS.claudePreviousPicker, json.modelPicker);
      this.log.info('Claude: backed up an existing modelPicker setting');
    }
    const picker = buildModelPicker(
      buildPickerRows(this.models, providersLabel(settings.providers), settings.claude.behavesAs),
      settings.claude.replaceBuiltInModels);
    if (!samePicker(json.modelPicker, picker)) {
      json.modelPicker = picker;
      writeSettingsJson(file, json);
      this.log.info(`Claude: wrote ${picker.options.length} picker rows to ${file}`);
    }
    await state.update(KEYS.claudeLastWrittenPicker, picker);

    // 4. Point the Claude Code extension at the router (and give slow local models time to answer).
    const next = entries.filter((e) => e.name !== CLAUDE_ENV_NAME);
    next.push({ name: CLAUDE_ENV_NAME, value: ourUrl });
    let changed = !existing || existing.value !== ourUrl;
    const timeoutEntry = entries.find((e) => e.name === CLAUDE_TIMEOUT_ENV);
    if (!timeoutEntry) {
      next.push({ name: CLAUDE_TIMEOUT_ENV, value: CLAUDE_TIMEOUT_VALUE });
      await state.update(KEYS.claudeManagedTimeout, CLAUDE_TIMEOUT_VALUE);
      changed = true;
    } else if (timeoutEntry.value !== state.get<string>(KEYS.claudeManagedTimeout)) {
      await state.update(KEYS.claudeManagedTimeout, undefined); // the user's own value: leave it alone
    }
    if (changed) {
      await claudeConfig.update('environmentVariables', next, vscode.ConfigurationTarget.Global);
      this.log.info(`Claude: set ${CLAUDE_ENV_NAME}=${ourUrl} in claudeCode.environmentVariables`);
    }
    await state.update(KEYS.claudeManagedBaseUrl, ourUrl);

    if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
      this.log.info('Claude: the Claude Code extension is not installed; settings are in place for when it is.');
    }
  }

  private async ensureRouter(settings: SwitcherSettings, upstream: string): Promise<void> {
    this.routerOptions = { settings, upstream };
    const key = JSON.stringify([
      settings.claude.routerPort,
      upstream,
      settings.providers.map((p) => [p.id, providerOrigin(p.baseUrl), p.apiKey]),
      settings.claude.dropMcpTools,
    ]);
    if (this.router && this.routerKey !== key) {
      await this.router.stop();
      this.router = undefined;
    }
    if (!this.routerWatch) {
      // Take over the port when the window that owns the router closes.
      this.routerWatch = setInterval(() => {
        if (!this.router && this.routerOptions) void this.queue(() => this.ensureRouter(this.routerOptions!.settings, this.routerOptions!.upstream));
      }, 20_000);
    }
    if (this.router) return;
    const router = new ClaudeRouter({
      port: settings.claude.routerPort,
      anthropicUpstream: upstream,
      resolveProvider: (m) => this.resolveProvider(m),
      providers: settings.providers.map((p) => providerOrigin(p.baseUrl)),
      sanitize: { dropMcpTools: settings.claude.dropMcpTools },
      log: this.log,
    });
    try {
      await router.start();
      this.router = router;
      this.routerKey = key;
      this.routerShared = false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      if (await isOurRouter(settings.claude.routerPort)) {
        if (!this.routerShared) this.log.info(`router on port ${settings.claude.routerPort} is provided by another VS Code window`);
        this.routerShared = true;
        return;
      }
      throw e;
    }
  }

  private async revertClaude(): Promise<void> {
    const state = this.context.globalState;
    if (this.routerWatch) clearInterval(this.routerWatch);
    this.routerWatch = undefined;
    this.routerOptions = undefined;
    await this.router?.stop();
    this.router = undefined;
    this.routerKey = '';
    this.routerShared = false;

    const file = claudeSettingsPath();
    const lastWritten = state.get<unknown>(KEYS.claudeLastWrittenPicker);
    if (lastWritten !== undefined && fs.existsSync(file)) {
      try {
        const json = readSettingsJson(file);
        if (samePicker(json.modelPicker, lastWritten)) {
          const previous = state.get<unknown>(KEYS.claudePreviousPicker);
          if (previous === undefined) delete json.modelPicker;
          else json.modelPicker = previous;
          writeSettingsJson(file, json);
          this.log.info('Claude: restored modelPicker setting');
        }
      } catch (e) {
        this.log.error(`Claude: could not restore ${file}: ${(e as Error).message}`);
      }
    }
    await state.update(KEYS.claudeLastWrittenPicker, undefined);
    await state.update(KEYS.claudePreviousPicker, undefined);

    const managed = state.get<string>(KEYS.claudeManagedBaseUrl);
    const managedTimeout = state.get<string>(KEYS.claudeManagedTimeout);
    if (managed || managedTimeout) {
      const { config, entries } = this.claudeEnv();
      let next = entries;
      let changed = false;
      const current = entries.find((e) => e.name === CLAUDE_ENV_NAME);
      if (managed && current && current.value === managed) {
        const previous = state.get<string>(KEYS.claudePreviousBaseUrl);
        next = next.filter((e) => e.name !== CLAUDE_ENV_NAME);
        if (previous) next.push({ name: CLAUDE_ENV_NAME, value: previous });
        this.log.info(`Claude: restored ${CLAUDE_ENV_NAME}${previous ? `=${previous}` : ' (removed)'}`);
        changed = true;
      }
      const timeout = entries.find((e) => e.name === CLAUDE_TIMEOUT_ENV);
      if (managedTimeout && timeout && timeout.value === managedTimeout) {
        next = next.filter((e) => e.name !== CLAUDE_TIMEOUT_ENV);
        changed = true;
      }
      if (changed) await config.update('environmentVariables', next.length > 0 ? next : undefined, vscode.ConfigurationTarget.Global);
    }
    await state.update(KEYS.claudeManagedBaseUrl, undefined);
    await state.update(KEYS.claudeManagedTimeout, undefined);
    await state.update(KEYS.claudePreviousBaseUrl, undefined);
  }

  // ------------------------------------------------------------------ Codex

  private get shimDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'codex');
  }

  private get shimPath(): string {
    return path.join(this.shimDir, 'codex-shim');
  }

  /** Returns true when the Codex extension must be restarted to pick the change up. */
  private async applyCodex(settings: SwitcherSettings): Promise<boolean> {
    if (process.platform === 'win32') {
      this.log.error('Codex integration is not available on Windows (the CLI wrapper needs a POSIX shell).');
      return false;
    }
    const state = this.context.globalState;
    const codexExtension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
    const realCodexHint = codexExtension ? codexBinaryInExtension(codexExtension.extensionPath) : undefined;

    fs.mkdirSync(this.shimDir, { recursive: true });
    const shimState: ShimState = {
      providers: settings.providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: normalizeBaseUrl(p.baseUrl),
        apiKey: p.apiKey || undefined,
        apiKeyEnv: apiKeyEnvName(p.id),
      })),
      models: this.models,
      reasoningEfforts: settings.codex.reasoningEfforts,
      realCodexHint,
      appServerWrapper: settings.codex.appServerWrapper || undefined,
      debug: settings.debug,
    };
    const statePath = path.join(this.shimDir, 'state.json');
    writeFileAtomic(statePath, JSON.stringify(shimState, null, 2));
    // Capability marker for transport installers; contains no provider configuration.
    writeFileAtomic(path.join(this.shimDir, 'app-server-wrapper-v1'), 'ai-provider-switcher/app-server-wrapper/v1\n', 0o600);
    const filters = Object.fromEntries(settings.providers.map((p) => [p.id, { include: p.include, exclude: p.exclude }]));
    writeFileAtomic(path.join(this.shimDir, 'filter.json'), JSON.stringify(filters));

    const runtime = path.join(this.context.extensionPath, 'out', 'codex', 'shim-runtime.js');
    const script = [
      '#!/bin/sh',
      '# Generated by the AI Provider Switcher VS Code extension. Do not edit; it is rewritten on every sync.',
      `AI_PROVIDER_SWITCHER_STATE=${shellQuote(statePath)}`,
      'export AI_PROVIDER_SWITCHER_STATE',
      `RUNTIME=${shellQuote(runtime)}`,
      '# After an extension update the baked path is gone until the next sync: fall back to the newest install.',
      'if [ ! -f "$RUNTIME" ]; then',
      '  for f in "$HOME"/.vscode*/extensions/durosoft.ai-provider-switcher-*/out/codex/shim-runtime.js \\',
      '           "$HOME"/.cursor/extensions/durosoft.ai-provider-switcher-*/out/codex/shim-runtime.js; do',
      '    [ -f "$f" ] && RUNTIME="$f"',
      '  done',
      'fi',
      'ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_RUN_AS_NODE',
      `exec ${shellQuote(process.execPath)} "$RUNTIME" "$@"`,
      '',
    ].join('\n');
    if (!fs.existsSync(this.shimPath) || fs.readFileSync(this.shimPath, 'utf8') !== script) {
      writeFileAtomic(this.shimPath, script, 0o755);
    }

    const previouslyManaged = state.get<string[]>(KEYS.codexManagedProviderIds, []);
    const managedNow = shimState.providers.map((p) => p.id);
    try {
      // Renamed or removed providers leave a stale table behind otherwise.
      for (const id of previouslyManaged) if (!managedNow.includes(id)) removeProviderFromConfig(id);
      if (settings.codex.writeConfigToml) {
        for (const provider of shimState.providers) {
          writeProviderToConfig({
            providerId: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            apiKeyEnv: provider.apiKey ? provider.apiKeyEnv : undefined,
          });
        }
        this.log.debug(`Codex: model_providers ${managedNow.join(', ')} present in ${codexConfigPath()}`);
      } else {
        // writeConfigToml was turned off: take back only the tables we put there.
        for (const id of previouslyManaged) removeProviderFromConfig(id);
      }
    } catch (e) {
      this.log.error(`Codex: could not update ${codexConfigPath()}: ${(e as Error).message}`);
    }
    await state.update(KEYS.codexManagedProviderIds, settings.codex.writeConfigToml ? managedNow : []);

    const codexConfig = vscode.workspace.getConfiguration('chatgpt');
    const current = codexConfig.inspect<string | null>('cliExecutable')?.globalValue ?? null;
    if (current === this.shimPath) return false;
    const managed = state.get<string>(KEYS.codexManagedCli);
    if (current && current !== managed) {
      await state.update(KEYS.codexPreviousCli, current);
      this.log.info(`Codex: remembering previous chatgpt.cliExecutable=${current}`);
    }
    await codexConfig.update('cliExecutable', this.shimPath, vscode.ConfigurationTarget.Global);
    await state.update(KEYS.codexManagedCli, this.shimPath);
    this.log.info(`Codex: chatgpt.cliExecutable -> ${this.shimPath}` + (realCodexHint ? ` (wrapping ${realCodexHint})` : ' (Codex extension not installed yet)'));
    return true;
  }

  private async revertCodex(): Promise<boolean> {
    const state = this.context.globalState;
    const settings = readSettings();
    const ids = new Set([...state.get<string[]>(KEYS.codexManagedProviderIds, []), ...settings.providers.map((p) => p.id)]);
    try {
      for (const id of ids) removeProviderFromConfig(id);
    } catch (e) {
      this.log.error(`Codex: could not clean ${codexConfigPath()}: ${(e as Error).message}`);
    }
    await state.update(KEYS.codexManagedProviderIds, undefined);
    const managed = state.get<string>(KEYS.codexManagedCli);
    if (!managed) return false;
    const codexConfig = vscode.workspace.getConfiguration('chatgpt');
    const current = codexConfig.inspect<string | null>('cliExecutable')?.globalValue ?? null;
    let changed = false;
    if (current === managed) {
      const previous = state.get<string>(KEYS.codexPreviousCli);
      await codexConfig.update('cliExecutable', previous ?? undefined, vscode.ConfigurationTarget.Global);
      this.log.info(`Codex: restored chatgpt.cliExecutable${previous ? `=${previous}` : ' (unset)'}`);
      changed = true;
    }
    await state.update(KEYS.codexManagedCli, undefined);
    await state.update(KEYS.codexPreviousCli, undefined);
    return changed;
  }
}

function describeError(e: unknown, settings: SwitcherSettings): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'EADDRINUSE') {
    return `port ${settings.claude.routerPort} is already in use; change aiProviderSwitcher.claude.routerPort or stop the other process`;
  }
  return err?.message ?? String(e);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

let switcher: Switcher | undefined;

export function activate(context: vscode.ExtensionContext): void {
  switcher = new Switcher(context);
  switcher.activate();
}

export async function deactivate(): Promise<void> {
  await switcher?.deactivate();
}
