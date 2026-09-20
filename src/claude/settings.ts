import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeModel, ProviderModel } from '../models';

export function claudeConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.claude');
}

export function claudeSettingsPath(): string {
  return path.join(claudeConfigDir(), 'settings.json');
}

export interface PickerRow {
  model: string;
  label?: string;
  description?: string;
  behavesAs?: string;
}

export interface ModelPickerSetting {
  options: PickerRow[];
  replaceBuiltInOptions?: boolean;
}

/** Claude Code assumes a 200k window for models it does not know; a `[1m]` suffix (stripped before sending) tells it the model takes 1M. */
export function claudeModelId(m: ProviderModel): string {
  return m.contextLength !== undefined && m.contextLength >= 1_000_000 ? `${m.id}[1m]` : m.id;
}

export function buildPickerRows(models: readonly ProviderModel[], providerName: string, behavesAs: string): PickerRow[] {
  return models.map((m) => {
    const row: PickerRow = { model: claudeModelId(m), label: m.id, description: describeModel(m, providerName) };
    if (behavesAs.trim() !== '') row.behavesAs = behavesAs.trim();
    return row;
  });
}

export function buildModelPicker(rows: PickerRow[], replaceBuiltInOptions: boolean): ModelPickerSetting {
  const picker: ModelPickerSetting = { options: rows };
  if (replaceBuiltInOptions) picker.replaceBuiltInOptions = true;
  return picker;
}

export function readSettingsJson(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} does not contain a JSON object`);
  return parsed;
}

export function writeSettingsJson(file: string, json: Record<string, any>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ai-provider-switcher.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function samePicker(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
