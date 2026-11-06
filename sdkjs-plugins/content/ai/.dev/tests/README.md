# AI plugin tests

Dev-only test suite for the AI plugin. Everything under `.dev/` is left out of the packaged plugin (`packer/pack.py` excludes `.dev/*` by default), so nothing here ships.

The plugin is plain browser JavaScript without a build step. The tests load the shipped scripts unchanged and run them against fake editors. No refactoring of the plugin was needed.

## Run

```sh
cd sdkjs-plugins/content/ai/.dev/tests
npm ci
npm test                 # vitest run
npm run test:watch       # re-run on change
npm run test:coverage    # with v8 coverage of scripts/**
```

The suite needs Node 20 or newer. It also needs `python3` for the check that `scripts/helpers/helpers.js` matches `.dev/helpers` (locally that test is skipped without Python; with `CI` set it fails instead). Set `AI_TESTS_VERBOSE=1` to see the plugin's console output.

CI runs the same suite in `.github/workflows/ai-plugin-tests.yml` on every PR and push that touches `sdkjs-plugins/content/ai/**`. Before the unit tests, CI also runs `node --check` on every plugin script and validates every JSON file.

## Layout

| Path | What |
|---|---|
| `lib/sandbox.js` | Loads plugin scripts into a `node:vm` context that acts like the plugin iframe. `window` is the global object, and top-level `let`/`class` declarations are shared between scripts, as with `<script>` tags. Timers are forwarded, so vitest fake timers work. |
| `fakes/host.js` | Fake editor host: `Asc.plugin.callCommand` / `executeMethod`. The real `library.js` builds `Asc.Editor` and `Asc.Library` on top of it. |
| `lib/plugin.js` | `createToolEnv(editor, fake)`: loads library, helpers and the tool registry. `call(name, args)` runs a tool. `expectToolError()` checks for a `ToolError`. |
| `tests/` | The test files (see below). |

### How the fakes stay honest

- **Commands run like they do in the editor.** `callCommand(func)` serializes `func` with `toString()` and evaluates it in a separate context. That context has only `Api` and a JSON copy of `Asc.scope`, so a tool that relies on a closure fails here exactly as it would in the editor. Results are JSON-cloned. An exception inside a command resolves to `undefined` and is recorded in `host.commandErrors`.
- **Unknown plugin methods are not ignored.** An `executeMethod` call that the fake does not implement throws.

## Test layers

| File | Layer |
|---|---|
| `registry.test.js` | Tool registry contract for each editor:<ul><li>tool names are unique, and each tool has a description, a label and en/de translations;</li><li>`parameters` is a valid JSON Schema (checked with ajv), and every example validates against it;</li><li>`getTools()` returns clean definitions;</li><li>`helpers.js` matches what `.dev/helpers/helpers.py` generates.</li></ul> |
| `providers.test.js` | OpenAI and Anthropic adapters (tool mapping, `tool_use`/`tool_result`, merging consecutive roles) and `engine.js` `_chatRequestAgent` with a stubbed `fetch` (streamed tool-call deltas, errors, stop). |
| `storage.test.js` | Loading stored and server-provided AI settings. |
| `static.test.js` | Every script parses, every JSON file is valid, the pages and providers reference files that exist, and every code file has a licence header. |

## Coverage

`npm run test:coverage` reports v8 coverage for `scripts/**`. The vm scripts are given `file://` URLs so that v8 can attribute their lines to the plugin files. Two things are not counted:

- code inside `callCommand(function(){...})`, because it is re-evaluated from source in the editor context, as in the real editor;
- settings and other UI pages, which are not tested.
