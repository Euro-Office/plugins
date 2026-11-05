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
curl http://localhost:8080/healthcheck
```

Open <http://localhost:8080/example/>, create or upload a document, then use the **AI** tab.

## Use a model

- **Ollama:** AI → Settings → add an Ollama model. The URL is `http://localhost:11434` (the default). Pick a model that supports tool calling, e.g. `qwen2.5:7b` or `llama3.1:8b`; otherwise the agent falls back to text-based function calls.
- **Cloud providers:** add your API key under AI → Settings. Keys stay in the browser's local storage.

## Edit and reload

The plugin folder is mounted read-only into the container. Edit files, then reload the editor tab (use a hard reload, or disable the cache in dev tools).
After changing a tool in `.dev/helpers`, regenerate `scripts/helpers/helpers.js`:

```sh
(cd .dev/helpers && python3 helpers.py)
```

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `EO_TAG` | `latest` | Document Server image tag, e.g. `nightly` |
| `EO_PORT` | `8080` | Port for the editor and example app |
| `EO_JWT_SECRET` | dev value | JWT secret (32+ chars) |
| `OLLAMA_PORT` | `11434` | Port for Ollama |

Example: `EO_TAG=nightly EO_PORT=9000 docker compose -f .dev/docker/compose.yml up -d`

## Stop

```sh
docker compose -f .dev/docker/compose.yml --profile ollama down      # keep pulled models
docker compose -f .dev/docker/compose.yml --profile ollama down -v   # also delete them
```

## Troubleshooting

- **Pull denied:** run `docker login ghcr.io` with a GitHub token that has `read:packages`.
- **Plugin missing or stale:** check that `http://localhost:8080/plugins.json` lists `{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}`. The list is cached briefly, so wait a minute or restart the container.
- **Ollama requests blocked (CORS):** `OLLAMA_ORIGINS` must allow the editor origin; the compose file sets `*`.
- The example app has no access control. Use this setup only locally.
