import * as path from 'node:path';

/** No shell interpolation: wrappers receive the real executable and exact argv. */
export function appServerCommand(realCodex: string, args: string[], wrapper?: string): { binary: string; args: string[] } {
  if (!wrapper) return { binary: realCodex, args };
  if (!path.isAbsolute(wrapper) || /[\x00-\x1f\x7f]/.test(wrapper) || wrapper === realCodex) {
    throw new Error('AI Provider Switcher: appServerWrapper must be a separate absolute executable path.');
  }
  return { binary: wrapper, args: [realCodex, ...args] };
}
