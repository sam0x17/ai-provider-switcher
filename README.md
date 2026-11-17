# AI Provider Switcher

A VS Code extension that puts the models served by one or more OpenAI-compatible
servers (LM Studio, Ollama, vLLM, llama.cpp, …) into the model pickers of the
**Codex** (`openai.chatgpt`) and **Claude Code** (`anthropic.claude-code`)
extensions, and makes those choices actually work: a request for a provider
model goes to the server that offers it, everything else keeps going to
OpenAI / Anthropic.

No files inside either extension are patched. The switcher uses the hooks the
two extensions already expose, so it survives their updates:

| Extension   | How models appear in the picker | How requests reach your server |
|-------------|----------------------------------|--------------------------------|
| Claude Code | Rows are written to the `modelPicker` setting in `~/.claude/settings.json` (an official Claude Code setting). | `ANTHROPIC_BASE_URL` in the extension's `claudeCode.environmentVariables` points at a local router (`127.0.0.1:41777`). The router forwards each provider model to the Anthropic-compatible `/v1/messages` endpoint of the server that offers it, and passes every other request through to Anthropic untouched (your OAuth login keeps working). |
| Codex       | `chatgpt.cliExecutable` points at a tiny wrapper around the bundled Codex CLI. For `app-server` sessions the wrapper sits on the JSON-RPC stream and appends the provider models to `model/list`. | The wrapper starts threads that use a provider model with `modelProvider` set to that server's `model_providers` entry (Responses API) which it also passes as `-c` overrides and, optionally, writes into `~/.codex/config.toml` for terminal use. |

## Requirements

* VS Code 1.96+, macOS or Linux (the Codex wrapper is a POSIX shell script; the Claude part also works on Windows).
* A server that speaks the OpenAI API at `<baseUrl>` **and**, for Claude Code, the Anthropic Messages API at `<origin>/v1/messages`. LM Studio, Ollama, vLLM and llama.cpp's server all do.
* For Codex the server must support the OpenAI **Responses** API (`/v1/responses`); Codex no longer speaks chat completions.

## Setup

1. Install the extension (`code --install-extension ai-provider-switcher-*.vsix`).
2. List your servers in `aiProviderSwitcher.providers`:

   ```jsonc
   "aiProviderSwitcher.providers": [
     { "name": "Mac Studio", "baseUrl": "http://192.168.1.128:8888/v1", "apiKey": "sk-…" },
     { "name": "Workstation", "baseUrl": "http://192.168.1.50:1234/v1" }
   ]
   ```

   For a single server you can instead just set `aiProviderSwitcher.baseUrl` (and `apiKey` / `providerName`);
   those settings are used whenever `providers` is empty.
3. When prompted, reload the window once so the Codex extension restarts its app-server through the wrapper.

The status bar shows the provider name (or how many servers are configured) and the number of models offered; click it to see them.
Every model is labelled with the server it comes from. If two servers offer the same model id the first one in the list wins;
a server that is unreachable is reported in the status bar while the others keep working.
Models are re-read from the server every `models.refreshMinutes` and on **AI Provider Switcher: Refresh Models**.

Every VS Code window runs its own copy of the extension; they all write the same settings, and only one of them
binds the router port — the others detect it through a health endpoint and take over if that window closes.

Open a new Codex chat or a new Claude Code conversation and the provider models are in the model picker.

## Commands

* **AI Provider Switcher: Refresh Models** — re-read the server's model list and re-apply.
* **AI Provider Switcher: Enable / Disable** — Disable restores `claudeCode.environmentVariables`, `chatgpt.cliExecutable`, the `modelPicker` setting and removes the `model_providers` entry.
* **AI Provider Switcher: Show Provider Models / Show Log / Open Settings**.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `aiProviderSwitcher.enabled` | `true` | Master switch. |
| `aiProviderSwitcher.providers` | `[]` | The servers to offer models from: `{ name, baseUrl, apiKey?, include?, exclude?, codexProviderId? }`. Empty means use the three single-server settings below. |
| `aiProviderSwitcher.baseUrl` | `http://localhost:1234/v1` | Single-server setup: OpenAI-compatible base URL including `/v1`. |
| `aiProviderSwitcher.apiKey` | `""` | Single-server setup: optional key for the server (Bearer / `x-api-key`; exposed to Codex as `<PROVIDERID>_API_KEY`). |
| `aiProviderSwitcher.providerName` | `LM Studio` | Single-server setup: label shown in the pickers. |
| `aiProviderSwitcher.models.include` / `.exclude` | `[]` / `["*embed*", "*rerank*", "*whisper*"]` | Glob filters on model ids, for servers that do not set their own. Embedding models reported by LM Studio are always hidden. |
| `aiProviderSwitcher.models.refreshMinutes` | `10` | Periodic refresh (0 = off). |
| `aiProviderSwitcher.claude.enabled` | `true` | Claude Code integration. |
| `aiProviderSwitcher.claude.routerPort` | `41777` | Local router port. |
| `aiProviderSwitcher.claude.anthropicUpstream` | `https://api.anthropic.com` | Where Anthropic traffic goes. A pre-existing `ANTHROPIC_BASE_URL` in `claudeCode.environmentVariables` is used instead and restored on disable. |
| `aiProviderSwitcher.claude.behavesAs` | `claude-sonnet-4-6` | Claude model whose client-side profile Claude Code applies to unknown models. |
| `aiProviderSwitcher.claude.replaceBuiltInModels` | `false` | Hide the Anthropic lineup in the Claude picker. |
| `aiProviderSwitcher.claude.dropMcpTools` | `false` | Strip `mcp__*` tools from requests to provider models (keeps prompts small for local models). |
| `aiProviderSwitcher.codex.enabled` | `true` | Codex integration. |
| `aiProviderSwitcher.codex.providerId` | `aiswitch` | `model_providers` id for a single-server setup, and the prefix for ids derived from `providers` entries (`aiswitch-mac-studio`). Must not be a built-in id such as `openai`, `lmstudio` or `ollama`. |
| `aiProviderSwitcher.codex.reasoningEfforts` | `["low","medium","high"]` | Effort choices shown for provider models. |
| `aiProviderSwitcher.codex.writeConfigToml` | `true` | Also keep the provider in `~/.codex/config.toml`. |
| `aiProviderSwitcher.codex.appServerWrapper` | `""` | Optional absolute executable for the app-server transport. Applies to this application; reload Codex after changing it. |
| `aiProviderSwitcher.debug` | `false` | Verbose logging. |

## What the router does to requests for provider models

Only requests whose `model` is a provider model are touched, and each one is sent to the server that listed it:

* Anthropic credentials (`authorization`, `x-api-key`) and `anthropic-beta` headers are removed and replaced by that server's key, if any.
* `metadata` (device / account ids) is dropped.
* Tool `input_schema`s are simplified: descriptive or grammar-hostile JSON-schema keywords (`format`, `pattern`, `additionalProperties`, `minimum`, `$schema`, …) are removed and `const` becomes `enum`. Local engines compile tool schemas into a sampling grammar and reject the originals otherwise.
* `/v1/messages/count_tokens` is answered locally with an estimate (local servers do not implement it).

Two environment variables are managed in `claudeCode.environmentVariables`: `ANTHROPIC_BASE_URL` (the router) and,
unless you already set one, `API_TIMEOUT_MS=3600000` so slow local models are not cut off. The Codex provider entry
gets `stream_idle_timeout_ms = 1800000` for the same reason.

Everything else — streaming, OAuth, the `/v1/models` probe, usage endpoints — is passed through byte for byte.

## Performance of local models

Both extensions send large prompts: Codex about 10k tokens, Claude Code 25k+ tokens plus one JSON schema per tool
(with claude.ai connectors enabled that was 209 tools and 430 KB in testing). Prompt processing speed therefore
decides whether a local model is usable at all — at 15 tokens/s a single Claude Code turn needs half an hour.
Measure your server with a few-thousand-token prompt before blaming the extensions, prefer a model that fits your
GPU, and turn on `aiProviderSwitcher.claude.dropMcpTools` when using Claude Code with local models. LM Studio also
aborts non-streaming requests whose prompt processing exceeds about five minutes ("Engine protocol predict request
failed"); the extensions stream, so they are not affected by that particular limit.

## LM Studio 0.4.20+ and Claude Code's tool list

LM Studio 0.4.20 and later compile every tool schema in a request into a llama.cpp sampling grammar, on
`/v1/messages`, `/v1/chat/completions` and `/v1/responses` alike, before any token is processed. Measured on a
deepseek-v4-flash deployment: 5 tools cost about 90 s of grammar setup on first use, 30 tools never finished
within LM Studio's internal 5-minute engine limit ("Engine protocol predict request failed: fetch failed"),
while a 45k-token request with no tools completed in 7 minutes. Codex sends about ten tools and works; Claude Code
sends 30 built-in tools plus one per MCP tool and therefore fails on those LM Studio versions regardless of the
router's schema cleanup. There is no server setting for either the grammar step or the 5-minute limit (the
Structured Output toggle does not disable it; see lmstudio-bug-tracker issue #2236). Until LM Studio changes this,
serve the model for Claude Code from LM Studio 0.4.16-2 or from another OpenAI+Anthropic-compatible server such as
llama.cpp's `llama-server`, and point a `providers` entry at it.

## Codex transport wrappers

Version 0.2.1 adds an optional `aiProviderSwitcher.codex.appServerWrapper` setting for tools such as Gent. Leave `chatgpt.cliExecutable` pointing to the switcher's generated shim. The switcher continues to supply model choices, provider overrides, credentials and RPC routing, then launches the transport as:

```text
WRAPPER REAL_CODEX_EXECUTABLE ORIGINAL_ARGUMENTS...
```

Arguments are passed directly without shell interpolation. The wrapper must preserve the app-server's JSON-lines input and output, and manage the native process it starts. Other commands, including `--version` and login, still go directly to Codex. An empty setting disables the wrapper. A configured wrapper that cannot launch fails explicitly; the switcher does not silently bypass it.

After installing or changing a wrapper, run **AI Provider Switcher: Refresh models**, then reload the VS Code window. Gent's compatible installer sets this value automatically. Each successful switcher sync writes a nonsecret `app-server-wrapper-v1` capability file next to the generated shim, so Gent can distinguish compatible versions without reading provider credentials. Removing Gent should remove only this wrapper setting and leave the switcher shim selected.

## Limitations

* **Codex cannot change provider inside an existing thread.** Picking a provider model in a chat that started on an OpenAI model — or on a different one of your servers — is rejected with an explanatory error; start a new chat instead.
* **Claude Code assumes a 200k context** for models it does not know. Models the server reports with a 1M+ window are written to the picker as `<id>[1m]`, which Claude Code strips before sending and treats as 1M; anything between 200k and 1M is still treated as 200k.
* The `modelPicker` rows are visible to the `claude` CLI in a terminal too, but the extension's router only runs while VS Code is open. For terminal use, either export `ANTHROPIC_BASE_URL=http://127.0.0.1:41777` while VS Code is running, or run the same router standalone: `node out/claude/router-cli.js --provider http://192.168.1.128:8888/v1 --api-key sk-…` (repeat `--provider`/`--api-key` per server; see the file header for `--port`, `--drop-mcp-tools`).
* Codex's own picker filtering is driven by OpenAI feature flags (`use_hidden_models`); if a future flag hides non-catalog models the provider rows disappear from the Codex picker until the flag is off.
* Windows: only the Claude Code integration is applied.

## Development

```sh
npm install
npm test          # compiles and runs the unit tests
npm run package   # builds the .vsix
```

`src/codex/shim-runtime.ts` is the process the Codex extension launches; it runs under VS Code's own Node (`ELECTRON_RUN_AS_NODE`) so no separate Node install is needed.
