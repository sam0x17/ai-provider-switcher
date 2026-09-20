import * as fs from 'node:fs';
import * as path from 'node:path';

/** Write a file atomically (temp file + rename) so concurrent readers never see a partial file. */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
