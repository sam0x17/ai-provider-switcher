import { ProviderModel } from '../models';

/** One configured server, as the shim needs it: a `model_providers` entry plus the key to reach it. */
export interface ShimProvider {
  /** The `model_providers` key; also the `provider` tag on this server's models. */
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** Environment variable the API key is exposed through (Codex `env_key`). */
  apiKeyEnv: string;
}

/**
 * Everything the Codex shim (a separate process) needs to know. Written by the
 * extension to <globalStorage>/codex/state.json and re-read by the shim when it changes.
 */
export interface ShimState {
  providers: ShimProvider[];
  /** Models from every provider, each tagged with the id of the one serving it. */
  models: ProviderModel[];
  reasoningEfforts: string[];
  /** Absolute path of the bundled codex binary at the time the state was written. */
  realCodexHint?: string;
  /** Optional user-configured transport wrapper; receives the real CLI path then its arguments. */
  appServerWrapper?: string;
  debug?: boolean;
}

/** Small file the shim owns for facts learned at runtime (survives restarts). */
export interface ShimMemory {
  /** The model_provider that was configured before we mirrored ours into config.toml. */
  originalModelProvider?: string;
  /** Every provider model we ever offered (lowercased id → provider id), so threads keep routing after a model is unloaded. */
  knownModels?: Record<string, string>;
}

export function apiKeyEnvName(providerId: string): string {
  return `${providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
}
