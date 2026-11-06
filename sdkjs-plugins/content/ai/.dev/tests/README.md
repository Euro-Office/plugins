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
| `fakes/word.js`, `cell.js`, `slide.js` | Small in-memory Document, Spreadsheet and Presentation Builder APIs (paragraphs/runs/tables/styles/comments/tracked changes/content controls; sheets/cells/formulas/comments/validation/freeze panes; slides/shapes/notes). |
| `fakes/aiedits/` | Minimal mocks used by the ported `aiEdits` / `toolApproval` / `toolPreviews` tests. |
| `lib/plugin.js` | `createToolEnv(editor, fake)`: loads library, provenance, helpers and the tool registry. `call(name, args)` runs a tool. `expectToolError()` checks for a `ToolError`. |
| `lib/agent.js` | `createAgent()`: runs the real `registerButtons()` (`scripts/engine/register.js` and the files it wires up: `actions.js`, `chatWindow.js`, `agentLoop.js`, `promptTools.js`, `contextMenu.js`, `toolbar.js`) with stub UI classes that follow the SDK `Button` classes, opens the chat window and fires `onChatMessage` like the chat sidebar does. A scripted fake provider stands in for the model. |
| `tests/` | The test files (see below). |
| `e2e/` | Opt-in end-to-end test against a real Document Server. |

### How the fakes stay honest

- **Commands run like they do in the editor.** `callCommand(func)` serializes `func` with `toString()` and evaluates it in a separate context. That context has only `Api` and a JSON copy of `Asc.scope`, so a tool that relies on a closure fails here exactly as it would in the editor. Results are JSON-cloned. An exception inside a command resolves to `undefined` and is recorded in `host.commandErrors`.
- **Method names and edge behaviour follow sdkjs `apiBuilder.js`.** The header comment of each fake lists the behaviour it reproduces. Examples:
  - `ApiWorksheet.GetRange("bad")` throws instead of returning null.
  - `ApiRange.GetFormula()` returns `"= SUM(...)"` with a space after the `=`.
  - `GetUsedRange()` always starts at A1.
  - `ApiTable` and `ApiBlockLvlSdt` have no `GetText()`; their text comes from `ApiDocumentContent.GetText()` (table cells, `GetContent()`).
  - `ApiParagraph.GetPosInParent()` is the position inside the innermost container (a table cell, for example), and `ApiParagraph` has no `GetParent()`.
  - Outline levels are 1-based.
- **Unknown plugin methods are not ignored.** An `executeMethod` call that the fake does not implement throws.

## Test layers

| File | Layer |
|---|---|
| `registry.test.js` | Tool registry contract for each editor:<ul><li>tool names are unique, and each tool has a description, a label and en/de translations;</li><li>`parameters` is a valid JSON Schema (checked with ajv), and every example validates against it;</li><li>`getTools()` returns clean definitions;</li><li>read-only flags match an explicit **allowlist**;</li><li>`helpers.js` matches what `.dev/helpers/helpers.py` generates.</li></ul> |
| `tools-word/cell/slide.test.js` | Tool behaviour against the fakes: happy paths, argument errors (ToolError messages) and edge cases. |
| `tool-arguments.test.js` | Safe argument parsing (`parseToolArguments`, `parseFuncCall`) and prompt-based calls through `AIPromptTools` and the agent loop: lenient JSON, payloads that try to inject code, unknown tools, and declining. |
| `agent-loop.test.js` | The real `onChatMessage` loop:<ul><li>message order for tool calls and tool results;</li><li>approval allow/always/deny, including the session-only "always" for writeMacro;</li><li>stop and the iteration cap;</li><li>prompt-based tool calls;</li><li>selection context in the system prompt;</li><li>request format, tool categories and `loadTools`;</li><li>history, transcripts and citations (`onNavigate`);</li><li>AI edits tracked as revisions, with undo.</li></ul> |
| `actions-menu.test.js` | Context menu and toolbar built by `registerButtons()`: the full menu outline per editor (snapshot), and for every one-shot action the request type, prompt, `Asc.Library` insert call and provenance meta. |
| `document-context.test.js`, `smart-actions.test.js` | `DocumentContext` snapshots and prompts, SmartActions ranking, and the selection-suggestion chips (debounce and fingerprint, with fake timers). |
| `providers.test.js` | OpenAI and Anthropic adapters (tool mapping, `tool_use`/`tool_result`, merging consecutive roles) and `engine.js` `_chatRequestAgent` with a stubbed `fetch` (streamed tool-call deltas, errors, stop). |
| `provenance.test.js` | AI-content marking:<ul><li>PNG/JPEG XMP round trips, using test images generated in Node;</li><li>document properties, written through the faithful `callCommand`;</li><li>content-control marking;</li><li>Library integration, `findAIContent` and the agent loop.</li></ul> |
| `tool-categories.test.js`, `agent-history.test.js`, `citations.test.js`, `tool-approval.test.js`, `ai-edits.test.js`, `tool-previews.test.js` | Feature tests that came with those features, ported to vitest. |
| `static.test.js` | Every script parses, every JSON file is valid, the pages (including `sidebar/index.html`) and providers reference files that exist, and the chat opens as a docked panel. |

The chat UI itself (`sidebar/`) is tested in `.dev/sidebar` with vitest and Testing Library; see `.dev/sidebar/README.md`.

## Adding a test for a new tool

1. Add the tool in `.dev/helpers/<editor>/` and regenerate: `(cd .dev/helpers && python3 helpers.py)`. The registry test fails until the generated file is updated.
2. Add a `"text"` label and en/de entries to `translations/helpers/`. If the tool must run without approval, mark it `"readOnly": true` **and** add it to `READ_ONLY` in `tests/registry.test.js`.
3. If the tool uses Builder API methods the fake does not have yet, add them to `fakes/<editor>.js`. Look the semantics up in sdkjs `apiBuilder.js` (return values on missing objects, thrown errors, index bases).
4. Write the behaviour test:

```js
import { createToolEnv, expectToolError } from "../lib/plugin.js";
import { createWordDocument } from "../fakes/word.js";

test("myTool does X", async () => {
	const fake = createWordDocument({ body: ["Hello", { text: "Title", style: "Heading 1" }], selection: { paragraph: 1 } });
	const { call, host } = createToolEnv("word", fake);
	expect(await call("myTool", { index: 2 })).toEqual({ ... });
	expect(fake.doc.texts()).toEqual([...]);          // document state
	expect(host.methodCalls("PasteHtml")).toHaveLength(1);  // plugin methods used
	await expectToolError(call("myTool", { index: 0 }), /"index" must be/);
});
```

## Coverage

`npm run test:coverage` reports v8 coverage for `scripts/**`. The vm scripts are given `file://` URLs so that v8 can attribute their lines to the plugin files. Three things are not counted:

- code inside `callCommand(function(){...})`, because it is re-evaluated from source in the editor context, as in the real editor;
- the chat sidebar, which has its own tests in `.dev/sidebar` (`npm test` there);
- settings and other UI pages, which are not tested.

## End-to-end (opt-in)

`e2e/` contains a Playwright test. It opens a new `.docx` in a real Document Server through the server's example app, with this plugin mounted, and points the plugin at `e2e/stub-llm.js`, an OpenAI-compatible stub that streams scripted responses. The test then:

1. sends a chat message;
2. checks that the approval card for `editParagraph` appears, and clicks **Allow**;
3. lets the stub request `readDocument`;
4. asserts that the document, as read back through the real Document API, contains the new text.

To run it locally (Docker and Chrome/Chromium required):

```sh
cd sdkjs-plugins/content/ai/.dev/tests/e2e
npm ci
npx playwright install chromium          # or: export CHROME_PATH=/usr/bin/google-chrome
./start-server.sh                        # Document Server on http://localhost (port 80)
npx playwright test
docker rm -f ai-plugin-e2e
```

Notes:

- **Port 80.** The example app builds document URLs from the browser host, and the document service fetches them from inside the container. Host and container port must therefore match, so `start-server.sh` publishes port 80. It also sets `ALLOW_PRIVATE_IP_ADDRESS=true` and registers the mounted plugin in the example's `pluginsData`.
- **Image.** The default image is `onlyoffice/documentserver:9.1`. `E2E_IMAGE=ghcr.io/euro-office/documentserver:latest` uses the Euro-Office build, whose paths are `/var/www/euro-office` and `/etc/euro-office`. `.dev/docker/compose.yml` is the interactive dev setup; the e2e script keeps its own minimal setup so that CI does not depend on compose profiles.
- **Plugin SDK.** The plugin pages load the plugin SDK from `onlyoffice.github.io`. The test serves the copy bundled with the Document Server instead, so the run needs no internet access.
- **Plugin settings.** The test preconfigures the provider and model in the editor origin's `localStorage`.

In CI, the e2e test runs as a separate job: nightly, or from **Actions → AI plugin tests → Run workflow** with *e2e* checked.

It was verified in the development sandbox with `onlyoffice/documentserver:9.1` and Chrome for Testing 153. `ghcr.io/euro-office/documentserver` could not be pulled there, because the sandbox proxy blocks the GHCR blob host; it is expected to work on GitHub runners.
