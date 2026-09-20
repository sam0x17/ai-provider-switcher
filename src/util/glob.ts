/** Minimal case-insensitive glob matching supporting `*` and `?`. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesAny(value: string, globs: readonly string[]): boolean {
  return globs.some((g) => g.trim() !== '' && globToRegExp(g.trim()).test(value));
}
