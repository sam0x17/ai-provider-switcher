/**
 * Line-oriented helpers for editing a TOML file without disturbing anything
 * outside the table we own. We deliberately avoid a full TOML round-trip so
 * that comments and formatting in ~/.codex/config.toml survive untouched.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HEADER_RE = /^\s*\[/;

function headerRegExp(table: string): RegExp {
  const parts = table.split('.').map((p) => escapeRegExp(p));
  // Tolerate whitespace and quoted keys: [model_providers.aiswitch] or [ "model_providers" . "aiswitch" ]
  const body = parts.map((p) => `"?${p}"?`).join('\\s*\\.\\s*');
  return new RegExp(`^\\s*\\[\\s*${body}\\s*\\]\\s*(#.*)?$`);
}

/** Returns [start, end) line indexes of the table's block, or undefined. */
export function findTable(lines: string[], table: string): [number, number] | undefined {
  const re = headerRegExp(table);
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !HEADER_RE.test(lines[end])) end++;
  return [start, end];
}

/** Replace (or append) a whole table. `body` holds the key/value lines without the header. */
export function upsertTable(source: string, table: string, body: string[]): string {
  const lines = source.split(/\r?\n/);
  const block = [`[${table}]`, ...body];
  const found = findTable(lines, table);
  if (found) {
    const [start, end] = found;
    // Keep one trailing blank line between this table and the next header.
    const next = end < lines.length ? [''] : [];
    lines.splice(start, end - start, ...block, ...next);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  const trimmed = source.replace(/\s+$/, '');
  return (trimmed === '' ? '' : trimmed + '\n\n') + block.join('\n') + '\n';
}

export function removeTable(source: string, table: string): string {
  const lines = source.split(/\r?\n/);
  const found = findTable(lines, table);
  if (!found) return source;
  const [start, end] = found;
  lines.splice(start, end - start);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Read a string-valued key. `table` undefined means the root (before the first header). */
export function readStringKey(source: string, table: string | undefined, key: string): string | undefined {
  const lines = source.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  if (table !== undefined) {
    const found = findTable(lines, table);
    if (!found) return undefined;
    [start, end] = found;
    start += 1;
  } else {
    const firstHeader = lines.findIndex((l) => HEADER_RE.test(l));
    if (firstHeader !== -1) end = firstHeader;
  }
  const re = new RegExp(`^\\s*"?${escapeRegExp(key)}"?\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`);
  for (let i = start; i < end; i++) {
    const m = re.exec(lines[i]);
    if (m) return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
  }
  return undefined;
}

/** Quote a string as a TOML basic string. */
export function tomlString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
