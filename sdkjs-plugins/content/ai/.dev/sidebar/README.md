# AI chat sidebar (sources)

The chat of the AI plugin is a docked right panel (`type: "panelRight"`) built with Preact, TypeScript and Vite. The sources live here, under `.dev/` (never packaged, `packer/pack.py` excludes `.dev/*`). The build output goes to `sdkjs-plugins/content/ai/sidebar/` and is committed.

```sh
cd sdkjs-plugins/content/ai/.dev/sidebar
npm ci
npm run build    # type check + build into ../../sidebar
npm test         # vitest + Testing Library in jsdom
npm run check    # build, then fail if ../../sidebar differs from git
npm run dev      # rebuild on change
```

## Why the output is committed

Same reason as `scripts/helpers/helpers.js` (see `.dev/helpers/README.md`): the plugin store (GitHub Pages), the Document Server plugin manager and the development setups use the repository files as they are, without a build step. CI (`.github/workflows/ai-plugin-tests.yml`) runs `npm run check` and fails if the committed `sidebar/` is out of date. After changing anything here, run `npm run build` and commit the sources **and** `sidebar/`. Do not edit `sidebar/` by hand.

The build is deterministic: library mode, one classic IIFE script (`sidebar.js`) and one stylesheet (`sidebar.css`), fixed names without hashes, no timestamps, exact dependency versions in `package-lock.json`. A classic script (not `type="module"`) also works from `file://` in the desktop editors.

## Layout

| File | What |
|---|---|
| `public/index.html` | The page, copied to `sidebar/index.html`. Loads the plugin SDK from `onlyoffice.github.io` like the other plugin pages, then the plain scripts shared with the background plugin, then the bundle. |
| `src/main.tsx` | Entry: `start(plugin, root)` registers the plugin events, `init` restores the chat and renders. Loads translations from `../translations/` (the SDK looks next to the page, which is `sidebar/translations/` here). |
| `src/chat.ts` | State and the whole message protocol with the background plugin. No DOM. |
| `src/App.tsx` | Components: message list, answers with actions, tool call cards, approval cards with previews, the AI edits bar, suggestion chips, attached text, input with voice and stop. |
| `src/markdown.ts` | markdown-it rendering, link allowlist, `eo://` location chips. |
| `src/styles.css` | Styles, using the editor theme variables. |
| `src/*.test.tsx` | Tests (vitest, jsdom, `@testing-library/preact`). `src/test-setup.ts` loads the shared plain scripts into jsdom. |

Scripts loaded by `index.html` before the bundle (not bundled, shared with the background plugin, kept small):

- `vendor/md/markdown-it.js` (`window.markdownit`). Raw HTML is off. Only `http:`, `https:`, `mailto:` and `eo:` links become links (`md.validateLink`); a click opens web links in a new tab and never navigates the frame.
- `scripts/helpers/agentHistory.js` (`window.AgentHistory`): request history from the chat items, transcript compaction and pruning.
- `scripts/helpers/citations.js` (`window.EOLinks`): `eo://` link validation, also used by the plugin before navigating.
- `scripts/chatVoice.js` (`window.initVoiceRecognitionEngine`): Web Speech API wrapper.
- `scripts/utils/theme.js` (`updateBodyThemeClasses`, `updateThemeVariables`): editor theme variables as CSS custom properties.

## Message protocol

The background plugin opens the sidebar in `scripts/engine/chatWindow.js` (`window.chatWindowShow`, used by the toolbar and context menu Chatbot buttons, the selection chips and tool approvals). The protocol is the one of the former `chat.html`/`chat.js`; names and payloads must not change without changing the plugin side too.

### Plugin to chat (`window.Asc.plugin.attachEvent`)

| Event | Payload | Sent by | Effect |
|---|---|---|---|
| `onChatStreamStart` | none | `agentLoop.js` | Hides the typing indicator, adds an empty answer that streams. |
| `onChatStreamChunk` | `string` | `agentLoop.js` | Appends to the streaming answer (ignored after Stop). |
| `onChatStreamEnd` | none | `agentLoop.js` (once per streamed request and once at the end of a turn) | Ends streaming and the turn: adds "Operation was interrupted." if stopped after a tool call, clears chat approvals (keeps editor ones), re-enables input and chips. |
| `onChatReply` | `string` | `agentLoop.js` (non-streamed reply, "Maximum iterations reached...", `"Error: [provider]"` when the request failed) | Adds the answer; an empty reply becomes the "Something went wrong" error item. Dropped after Stop. |
| `onToolCallStart` | `{ type: "native", id, functionName, humanName, arguments, source? }` or `{ type: "system_prompt", id, call }` | `agentLoop.js`, `toolApproval.js` (editor calls) | Adds a tool call card, or a call to the previous card for the same tool. |
| `onToolCallEnd` | same plus `result` (`{message}`, `{error}`, object or string) | same | Sets the result, removes the approval prompts of that call. |
| `onToolCall` | start and result in one (deprecated) | older plugins | Adds a finished call. |
| `onToolApprovalRequest` | `{ id, toolCallId, functionName, humanName, arguments, source: "chat"\|"editor", code?, preview? }` | `toolApproval.js` | Approval card on the tool call card (creates one if needed): question, editor-request label, preview (`items`, `text`, `table`, `note` from `toolPreviews.js`, text only), macro code for `writeMacro`, arguments. Takes focus. |
| `onAgentTranscript` | `{ turnId, messages, hasFinalReply }` | `agentLoop.js` | Compacted transcript stored on the user message of that turn, then `AgentHistory.pruneTranscripts`. |
| `onAIEditsSummary` | `{ turnId, steps, canUndo, undoAvailable, revisionCount, editorType }` | `aiEdits.js` | "Undo AI changes" bar on the turn's answer (or a bar of its own). Older bars lose `undoAvailable`. |
| `onAIEditsActionResult` | `{ turnId, action, ok, reason?, left?, summary? }` | `chatWindow.js` | Updates that bar: undone, accepted, rejected, partial, stale or error messages. |
| `onSelectionSuggestions` | `{ key, summary, actions: [{ id, text }] }` | `selectionSuggestions.js` | Suggestion chips above the input (until dismissed for this `key`, hidden while the agent runs). |
| `onAttachedText` | `string`, `{ text }` or `{ text, forceSend: true }` | `chatWindow.js` (context menu, chips, approvals) | Puts the text into the input, or sends it right away. |
| `onVoiceInputSupport` | `boolean` | `chatWindow.js` | Shows the microphone button. |
| `onUpdateState` | none | `chatWindow.js` (before re-docking reloads the page) | Saves the chat to `localStorage["onlyoffice_ai_chat_state"]` and answers `onUpdateState`. |
| `onThemeChanged` | editor theme | `code.js`; also `Asc.plugin.onThemeChanged` | Theme type, body classes, theme variables, compact corners for non-standard themes. |

### Chat to plugin (`window.Asc.plugin.sendToPlugin`)

| Event | Payload | Handled in |
|---|---|---|
| `onWindowReady` | `{}` | `chatWindow.js`: marks approvals ready, sends voice support and attached text, attaches the selection chips. |
| `onChatMessage` | `{ messages: AgentHistory.build(items), usedTools: AgentHistory.collectToolNames(items), turnId }` | `chatWindow.js` → `AIEdits.wrapChatHandler` → `AIAgentLoop.runTurn`. Items exclude the UI-only `aiEditsOnly` placeholder; turns ending in an error are dropped by `build`. |
| `onToolApprovalResponse` | `{ id, decision: "allow"\|"always"\|"deny" }` | `ToolApproval.respond` |
| `onStopAgent` | `{}` | `chatWindow.js`: stops the loop and denies pending approvals (the chat removes its cards). |
| `onNavigate` | `{ href }` (valid `eo://` only, not while the agent runs) | `chatWindow.js`: validated again, selects the place. |
| `onAIEditsAction` | `{ turnId, action: "undo"\|"accept"\|"reject" }` | `AIEdits.performAction` |
| `onChatReplace` | `{ type: "insert"\|"replace"\|"comment"\|"review", data }` | `chatWindow.js`: `InsertAsHTML`, `ReplaceTextSmart`, `InsertAsComment`, `InsertAsReview` (word only). Location links are stripped. |
| `onSmartActionChip` | `{ id }` | `selectionSuggestions.js`: runs the smart action. |
| `onSelectionSuggestionsBusy` | `boolean` (only on change) | `selectionSuggestions.js` |
| `onUpdateState` | none | `chatWindow.js` (answer to `onUpdateState`) |

### Stored state

`localStorage["onlyoffice_ai_chat_state"] = { messages, inputValue, attachedText }`, written on `onUpdateState` and cleared by the plugin when the chat closes or the plugin starts (`clearChatState` in `code.js`). Items:

- user: `{ role: "user", content, turnId, attachedText?, agentTranscript? }`
- answer: `{ role: "assistant", content: [text], activeContentIndex, error?, aiEdits?, aiEditsOnly? }`
- tool: `{ role: "tool", isToolCall: true, functionName, humanName, calls: [{ arguments, result }] }` (older states with `arguments`/`result` on the item are migrated)

## Features

- Message list with markdown and streaming, follows new content while scrolled to the bottom.
- Answer actions (real buttons, visible on the last answer, on hover and on focus): Update (send the last question again), Copy, Replace original text, Insert result, In comment, As review (document editor only), Delete (removes the whole turn so the history stays consistent).
- Tool call cards, collapsible, with arguments and results (`writeMacro` shows the code).
- Approval cards: Allow, Always allow (Allow for this session for macros), Deny; previews as definition list, before/after text and a cell table.
- AI edits bar: Undo AI changes, Accept all, Reject all, Ctrl+Z hints, status messages.
- Suggestion chips: dismiss button and Escape, hidden while the agent runs.
- `eo://` citation chips with tooltip, click navigates.
- Attached text banner, voice input, Stop, error toast (5 s, click to close).
- Token counter behind the `SHOW_TOKENS_INFO` flag in `App.tsx` (off, as before; needs `vendor/GPT-3-Encoder` loaded when turned on).
- Strings through `Asc.plugin.tr` and `translations/*.json`.
