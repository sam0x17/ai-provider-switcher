import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic } from '../util/fs';
import { removeTable, tomlString, upsertTable } from '../util/toml';

export function codexHome(): string {
  const env = process.env.CODEX_HOME;
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.codex');
}

export function codexConfigPath(): string {
  return path.join(codexHome(), 'config.toml');
}

export interface ProviderEntry {
  providerId: string;
  name: string;
  baseUrl: string;
  /** Environment variable holding the API key; omitted when no key is configured. */
  apiKeyEnv?: string;
}

/** 30 minutes: how long Codex waits for the next SSE event from the provider. */
export const STREAM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export const MANAGED_COMMENT = '# Managed by the AI Provider Switcher VS Code extension; edits here are overwritten.';

export function providerTableBody(entry: ProviderEntry): string[] {
  const lines = [
    MANAGED_COMMENT,
    `name = ${tomlString(entry.name)}`,
    `base_url = ${tomlString(entry.baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    // Local models can spend minutes on prompt processing before the first SSE event.
    `stream_idle_timeout_ms = ${STREAM_IDLE_TIMEOUT_MS}`,
  ];
  if (entry.apiKeyEnv) lines.push(`env_key = ${tomlString(entry.apiKeyEnv)}`);
  return lines;
}

/** `-c key=value` overrides equivalent to the table, for the app-server command line. */
export function providerOverrides(entry: ProviderEntry): string[] {
  const p = `model_providers.${entry.providerId}`;
  const args = [
    '-c', `${p}.name=${tomlString(entry.name)}`,
    '-c', `${p}.base_url=${tomlString(entry.baseUrl)}`,
    '-c', `${p}.wire_api="responses"`,
    '-c', `${p}.requires_openai_auth=false`,
    '-c', `${p}.stream_idle_timeout_ms=${STREAM_IDLE_TIMEOUT_MS}`,
  ];
  if (entry.apiKeyEnv) args.push('-c', `${p}.env_key=${tomlString(entry.apiKeyEnv)}`);
  return args;
}

export function writeProviderToConfig(entry: ProviderEntry, configPath = codexConfigPath()): void {
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const updated = upsertTable(existing, `model_providers.${entry.providerId}`, providerTableBody(entry));
  if (updated !== existing) writeFileAtomic(configPath, updated);
}

export function removeProviderFromConfig(providerId: string, configPath = codexConfigPath()): void {
  if (!fs.existsSync(configPath)) return;
  const existing = fs.readFileSync(configPath, 'utf8');
  const updated = removeTable(existing, `model_providers.${providerId}`);
  if (updated !== existing) writeFileAtomic(configPath, updated);
}
