# Local test server

Starts Euro-Office Document Server with this AI plugin mounted live, plus an optional local LLM (Ollama).

## Start

Run from `sdkjs-plugins/content/ai`:

```sh
# Document Server with this plugin
docker compose -f .dev/docker/compose.yml up -d

# ...or with a local LLM as well
docker compose -f .dev/docker/compose.yml --profile ollama up -d
docker compose -f .dev/docker/compose.yml exec ollama ollama pull qwen2.5:7b
```

First start takes a minute or two (fonts are generated). It is ready when this prints `true`:

```sh
curl http://localhost/healthcheck
```

Open <http://localhost/example/>, create or upload a document, then use the **AI** tab.

The server uses port 80 on purpose: the example app builds document URLs from the browser's host and port, and the server fetches them from inside the container, so both sides must match.

## Use an OpenAI-compatible endpoint

Preconfigure the server with any OpenAI-compatible API (OpenAI, Mistral, OpenRouter, vLLM, LiteLLM, LocalAI, …). The key stays on the server; the plugin sends requests through the Document Server's `/ai-proxy`, which adds the key. Chat, summarization, translation and text analysis use the model right away, with no setup in the browser.

```sh
OPENAI_BASE_URL=https://api.openai.com/v1 \
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-4.1-mini \
docker compose -f .dev/docker/compose.yml -f .dev/docker/compose.ai.yml up -d
```

Or put the variables in `.dev/docker/.env` (git-ignored) and drop the prefix.

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_BASE_URL` | required | Base URL including `/v1` (requests go to `<base>/chat/completions`) |
| `OPENAI_API_KEY` | empty | Sent as `Authorization: Bearer …` by the proxy |
| `OPENAI_MODEL` | required | Model id as the endpoint expects it |
| `OPENAI_PROVIDER_NAME` | `OpenAI-compatible` | Name shown in the plugin |
| `OPENAI_MODEL_CAPABILITIES` | `257` (chat + tools) | Bit mask: chat 1, image 2, vision 128, tools 256. Use `1` if the model has no tool calling |
| `OPENAI_MAX_INPUT_TOKENS` | `128000` | Context size used for chunking long texts |

- An endpoint on your machine (e.g. LM Studio or vLLM on port 1234): `OPENAI_BASE_URL=http://host.docker.internal:1234/v1`.
- The bundled Ollama: add `--profile ollama` and use `OPENAI_BASE_URL=http://ollama:11434/v1`.

While server settings are active, users can't change models in the plugin settings. Restart without `compose.ai.yml` to go back to settings in the browser.

## Use a model

- **Ollama:** AI → Settings → add an Ollama model. The URL is `http://localhost:11434` (the default). Pick a model that supports tool calling, e.g. `qwen2.5:7b` or `llama3.1:8b`; otherwise the agent falls back to text-based function calls.
- **Cloud providers:** add your API key under AI → Settings. Keys stay in the browser's local storage.

## Edit and reload

The plugin folder is mounted read-only into the container. Edit files, then reload the editor tab (use a hard reload, or disable the cache in dev tools).
After changing a tool in `.dev/helpers`, regenerate `scripts/helpers/helpers.js` (it is committed on purpose, see `.dev/helpers/README.md`):

```sh
(cd .dev/helpers && python3 helpers.py)
```

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `EO_TAG` | `latest` | Document Server image tag, e.g. `nightly` |
| `EO_JWT_SECRET` | dev value | JWT secret (32+ chars) |
| `OLLAMA_PORT` | `11434` | Port for Ollama |

Example: `EO_TAG=nightly docker compose -f .dev/docker/compose.yml up -d`

## Stop

```sh
docker compose -f .dev/docker/compose.yml --profile ollama down      # keep pulled models
docker compose -f .dev/docker/compose.yml --profile ollama down -v   # also delete them
```

## Troubleshooting

- **Pull denied:** run `docker login ghcr.io` with a GitHub token that has `read:packages`.
- **Code changes not showing:** the server sends plugin files with a one-year `immutable` cache header, so a normal reload keeps old files. Use a private window or enable "Disable cache" in dev tools. Docker Desktop can also take a few seconds to sync edited files into the container.
- **Plugin missing or stale:** check that `http://localhost/plugins.json` lists `{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}`. The list is cached briefly, so wait a minute or restart the container.
- **Ollama requests blocked (CORS):** `OLLAMA_ORIGINS` must allow the editor origin; the compose file sets `*`.
- The example app has no access control. Use this setup only locally.
