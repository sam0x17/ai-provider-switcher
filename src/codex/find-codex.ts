import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ROOTS = ['.vscode', '.vscode-insiders', '.vscode-server', '.vscode-server-insiders', '.vscodium', '.cursor', '.windsurf'];

function versionKey(dirName: string): number[] {
  // openai.chatgpt-26.825.51511-darwin-arm64 -> [26, 825, 51511]
  const m = /^openai\.chatgpt-(\d+(?:\.\d+)*)/.exec(dirName);
  return m ? m[1].split('.').map((n) => Number(n)) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Find the codex binary shipped inside an installed Codex extension directory. */
export function codexBinaryInExtension(extensionDir: string): string | undefined {
  const bin = path.join(extensionDir, 'bin');
  if (!fs.existsSync(bin)) return undefined;
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const sub of fs.readdirSync(bin)) {
    const candidate = path.join(bin, sub, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Locate the newest installed Codex extension's bundled binary across known editors. */
export function findBundledCodex(hint?: string): string | undefined {
  if (hint && fs.existsSync(hint)) return hint;
  const home = os.homedir();
  let best: { key: number[]; file: string } | undefined;
  for (const root of EXTENSION_ROOTS) {
    const extensions = path.join(home, root, 'extensions');
    if (!fs.existsSync(extensions)) continue;
    for (const dir of fs.readdirSync(extensions)) {
      if (!dir.startsWith('openai.chatgpt-')) continue;
      const file = codexBinaryInExtension(path.join(extensions, dir));
      if (!file) continue;
      const key = versionKey(dir);
      if (!best || compareVersions(key, best.key) > 0) best = { key, file };
    }
  }
  return best?.file;
}
