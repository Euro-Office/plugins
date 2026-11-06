# AI agent tools (sources)

Each file under `word/`, `cell/` and `slide/` defines one tool of the chat agent (a `RegisteredFunction`: name, label, description, JSON Schema parameters and the `call` implementation). `helpers.py` concatenates them into `scripts/helpers/helpers.js`, which is the file the plugin loads (`index.html`). It also builds the per-editor name → label maps and strips the `"text"` labels from the tool definitions.

After adding or changing a tool, regenerate:

```sh
cd sdkjs-plugins/content/ai/.dev/helpers
python3 helpers.py
```

Then commit the tool source **and** `scripts/helpers/helpers.js`. See `.dev/tests/README.md` ("Adding a test for a new tool") for labels, translations, the read-only allowlist and tests.

## Why `helpers.js` is committed

`helpers.js` is generated, but it stays in git, because some consumers use the repository contents as they are, with no build step that could generate it:

- **GitHub Pages / plugin store.** The repository is published as a static site (`.github/workflows/pack-plugins.yml` runs on `page_build`). The store (`store/scripts/code.js`) loads plugins from `<site>/sdkjs-plugins/content/<name>/`, and the editor runs the plugin's files from there.
- **Document Server plugins manager.** `documentserver-pluginsmanager` (Euro-Office/core, `DesktopEditor/pluginsmanager/main.cpp`) installs marketplace plugins from `<site>/sdkjs-plugins/content/<name>/deploy/<name>.plugin`, a committed archive. Only as a fallback does it use the release asset that `packer/pack.py` builds. The Document Server image itself does not fetch this repository at build time.
- **Development setups.** `.dev/docker` and the e2e test mount the plugin folder into a Document Server unchanged.

`packer/pack.py` (release assets) and the test loader could generate the file, but the consumers above could not. So the generated file is kept and checked instead:

- CI (`.github/workflows/ai-plugin-tests.yml`) runs `helpers.py` and fails if `scripts/helpers/helpers.js` differs from the committed file.
- The unit test `registry.test.js` ("generated helpers.js is in sync") does the same check locally. It is skipped without Python, except when `CI` is set; then it fails instead.

Do not edit `scripts/helpers/helpers.js` by hand.
