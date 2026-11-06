// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Chat state and the message protocol with the background plugin
// (scripts/engine/chatWindow.js and friends). Every event name and payload
// is the one the former chat.js used; README.md lists them. The components
// (App.tsx) only render this state and call the actions below.

import type { PluginApi, Theme } from "./globals";

export const STORAGE_KEY = "onlyoffice_ai_chat_state";
export const ERROR_UNKNOWN = 1;

// Fills %1..%9 in one pass, so values are never substituted again and
// "$&" in a value stays literal (unlike String.replace with a string).
export function fill(text: string, ...values: (string | number)[]): string {
	return text.replace(/%(\d)/g, (match, i) => i >= 1 && i <= values.length ? String(values[i - 1]) : match);
}

// One tool call. summary/resultSummary/groupPhrase are the plain-language
// sentences from the plugin (EditorHelper.describeToolCall); older plugins
// and stored chats may lack them.
export interface ToolCallEntry {
	arguments: string;
	result: string | null;
	functionName?: string;
	humanName?: string;
	summary?: string;
	resultSummary?: string;
	groupPhrase?: string;
	failed?: boolean;
	declined?: boolean;
}

type ToolCallData = Partial<ToolCallEntry>;

export interface AIEdits {
	turnId: string;
	steps?: number;
	canUndo?: boolean;
	undoAvailable?: boolean;
	revisionCount?: number;
	editorType?: string;
	busy?: boolean;
	undone?: boolean;
	resolved?: string;
	message?: string;
}

export interface Item {
	id: number; // UI key, not persisted
	role: "user" | "assistant" | "tool";
	content?: string | string[];
	turnId?: string;
	attachedText?: string;
	agentTranscript?: { messages: object[]; hasFinalReply: boolean };
	activeContentIndex?: number;
	error?: number | null;
	aiEdits?: AIEdits;
	aiEditsOnly?: boolean;
	isToolCall?: boolean;
	// Tool calls the editor requested (toolApproval.js, source "editor"),
	// kept apart from the agent turn's tool calls.
	fromEditor?: boolean;
	functionName?: string;
	humanName?: string;
	calls?: ToolCallEntry[];
}

export interface ApprovalData {
	id: string;
	toolCallId?: string;
	functionName?: string;
	humanName?: string;
	summary?: string;
	arguments?: string;
	source?: string;
	code?: string;
	preview?: Preview;
}

export interface Preview {
	items?: { label?: unknown; value?: unknown }[];
	text?: { before?: unknown; after?: unknown };
	table?: { columns?: unknown[]; rows?: { label?: unknown; cells?: { before?: unknown; after?: unknown }[] }[]; truncated?: boolean };
	note?: unknown;
}

export interface Approval {
	data: ApprovalData;
	toolCallId?: string;
	itemId: number;
}

export interface Chips {
	key: string;
	summary: string;
	actions: { id: string; text: string }[];
}

export interface State {
	items: Item[];
	input: string;
	attachedText: string;
	running: boolean;
	stopped: boolean;
	typing: boolean;
	// Status line while the agent runs: model name (onAgentStatus), the
	// running tool's human name and when the turn started (Date.now()).
	agentModel: string;
	activeTool: string | null;
	turnStart: number;
	streamingIndex: number | null;
	approvals: Record<string, Approval>;
	chips: Chips | null;
	chipsDismissedKey: string | null;
	chipsBusy: boolean;
	voiceSupported: boolean;
	recording: boolean;
	error: string;
	themeType: string;
	compactRadius: boolean;
	// bumped to move the focus to the input (after a reply, dismiss, ...)
	focusInput: number;
	// bumped when translations arrive, so memoized text is rebuilt
	trVersion: number;
}

type ToolIndex = { itemId: number; callIndex: number };

export function createChat(plugin: PluginApi, storage: Storage = window.localStorage) {
	let listeners: (() => void)[] = [];
	let nextId = 1;
	let toolCallIndices: Record<string, ToolIndex> = {};
	// Tool call shown in the status line (state.activeTool).
	let statusToolId: string | null = null;
	let errTimer: ReturnType<typeof setTimeout> | null = null;
	let translations: Record<string, string> = {};

	const state: State = {
		items: [], input: "", attachedText: "",
		running: false, stopped: false, typing: false, streamingIndex: null,
		agentModel: "", activeTool: null, turnStart: 0,
		approvals: {},
		chips: null, chipsDismissedKey: null, chipsBusy: false,
		voiceSupported: false, recording: false,
		error: "", themeType: "light", compactRadius: false, focusInput: 0, trVersion: 0
	};

	function changed() {
		listeners.forEach((f) => f());
	}

	function tr(text: string): string {
		return translations[text] || plugin.tr(text);
	}

	function send(name: string, data?: unknown) {
		plugin.sendToPlugin(name, data);
	}

	function push(item: Omit<Item, "id">): Item {
		let full = { ...item, id: nextId++ } as Item;
		if (full.role === "assistant" && !full.isToolCall)
			full.activeContentIndex = full.activeContentIndex || 0;
		state.items = state.items.concat(full);
		return full;
	}

	function touch(item: Item) {
		// new object so memoized components re-render
		let i = state.items.indexOf(item);
		if (i < 0)
			return item;
		let copy = { ...item };
		state.items = state.items.slice();
		state.items[i] = copy;
		return copy;
	}

	// ── Persistence ───────────────────────────────────────────────────────
	function serialize() {
		return {
			messages: state.items.map(({ id, ...rest }) => rest),
			inputValue: state.input,
			attachedText: state.attachedText
		};
	}

	function restore() {
		let saved: any = null;
		try {
			saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
		} catch (e) {
			saved = null;
		}
		if (!saved)
			return;
		if (Array.isArray(saved.messages)) {
			let messages = saved.messages.filter((m: any) => m && typeof m === "object");
			// States saved before transcripts were capped may hold many.
			window.AgentHistory.pruneTranscripts(messages);
			state.items = [];
			for (let m of messages) {
				let { $el, btnTips, id, ...item } = m;
				// Older tool call format: arguments/result on the item.
				if (item.isToolCall && !item.calls)
					item.calls = [{ arguments: item.arguments || "", result: item.result !== undefined ? item.result : null }];
				push(item);
			}
		}
		if (saved.inputValue)
			state.input = String(saved.inputValue);
		if (saved.attachedText)
			state.attachedText = String(saved.attachedText);
	}

	// ── Errors ────────────────────────────────────────────────────────────
	function setError(message: string) {
		state.error = tr(message);
		if (errTimer)
			clearTimeout(errTimer);
		errTimer = setTimeout(clearError, 5000);
		changed();
	}

	function clearError() {
		if (errTimer)
			clearTimeout(errTimer);
		errTimer = null;
		state.error = "";
		changed();
	}

	// ── Chips ─────────────────────────────────────────────────────────────
	// isLocal: do not notify the plugin (it already knows, e.g. chip click).
	function setChipsBusy(busy: boolean, isLocal = false) {
		if (state.chipsBusy === busy)
			return;
		state.chipsBusy = busy;
		if (!isLocal)
			send("onSelectionSuggestionsBusy", busy);
	}

	function chipsVisible() {
		let c = state.chips;
		return !!c && c.actions.length > 0 && !state.chipsBusy && c.key !== state.chipsDismissedKey;
	}

	// ── Sending ───────────────────────────────────────────────────────────
	// Items that are part of the conversation sent to the model. The
	// "AI changes" placeholder (aiEditsOnly) is UI only.
	function historyItems() {
		return state.items.filter((item) => !item.aiEditsOnly);
	}

	function sendMessage(text: string) {
		// turnId links the agent transcript of this turn back to this message
		// (see onAgentTranscript).
		let message: Omit<Item, "id"> = { role: "user", content: text, turnId: "t" + Date.now().toString(36) + Math.random().toString(36).substring(2, 8) };
		if (state.attachedText) {
			message.attachedText = state.attachedText;
			state.attachedText = "";
		}
		push(message);
		state.typing = true;
		state.running = true;
		state.stopped = false;
		state.activeTool = null;
		statusToolId = null;
		state.turnStart = Date.now();
		setChipsBusy(true);

		// Rebuild the request history (scripts/helpers/agentHistory.js): turns
		// that ended in an error are dropped, tool UI items are skipped and
		// stored agent transcripts are re-inserted.
		let list = historyItems();
		send("onChatMessage", {
			messages: window.AgentHistory.build(list),
			usedTools: window.AgentHistory.collectToolNames(list),
			turnId: message.turnId
		});
		changed();
	}

	function finishAgent() {
		state.typing = false;
		state.running = false;
		state.stopped = false;
		state.activeTool = null;
		statusToolId = null;
		setChipsBusy(false);
		state.focusInput++;
	}

	// ── Tool calls and approvals ──────────────────────────────────────────
	function addToolCall(data: ToolCallData, source?: string): ToolIndex {
		let call: ToolCallEntry = { ...data, arguments: data.arguments || "", result: data.result !== undefined ? data.result : null };
		let last = state.items[state.items.length - 1];
		let fromEditor = source === "editor";
		// Consecutive tool calls of the same origin share one card (one collapsed group line).
		if (last && last.isToolCall && !!last.fromEditor === fromEditor) {
			let item = touch(last);
			item.calls = (item.calls || []).concat(call);
			return { itemId: item.id, callIndex: item.calls.length - 1 };
		}
		let item = push({ role: "tool", isToolCall: true, functionName: data.functionName, humanName: data.humanName || data.functionName, calls: [call], ...(fromEditor ? { fromEditor } : {}) });
		return { itemId: item.id, callIndex: 0 };
	}

	function updateToolCallResult(index: ToolIndex, result: string, extra: ToolCallData) {
		let item = state.items.find((i) => i.id === index.itemId);
		if (!item || !item.isToolCall || !item.calls || !item.calls[index.callIndex])
			return;
		item = touch(item);
		item.calls = item.calls!.slice();
		item.calls[index.callIndex] = { ...item.calls[index.callIndex], ...extra, result };
	}

	function parseCall(data: any) {
		let name = "Unknown";
		let args = "";
		if (data.type === "native") {
			name = data.functionName || "Unknown";
			args = data.arguments || "";
		} else if (data.type === "system_prompt" && typeof data.call === "string") {
			let nameMatch = data.call.match(/\(([^)]+)\)/);
			if (nameMatch)
				name = nameMatch[1];
			let argsMatch = data.call.match(/\{[\s\S]*\}/);
			if (argsMatch) {
				try {
					args = JSON.stringify(JSON.parse(argsMatch[0]), null, 2);
				} catch (e) {
					args = argsMatch[0];
				}
			}
		}
		return { name, args };
	}

	function parseResult(data: any): string {
		if (data.type === "native") {
			return typeof data.result === "object" && data.result !== null
				? (data.result.message || data.result.error || JSON.stringify(data.result))
				: (data.result || "Success");
		}
		if (data.type === "system_prompt")
			return data.result ? (data.result.message || data.result.error || "Success") : "";
		return "";
	}

	// Sentence fields of onToolCallStart/End (only those that are set).
	function summaryFields(data: any): ToolCallData {
		let fields: ToolCallData = {};
		for (let key of ["summary", "resultSummary", "groupPhrase"] as const) {
			if (typeof data[key] === "string" && data[key])
				fields[key] = data[key];
		}
		return fields;
	}

	// The call failed (not declined by the user): result { error } without declined.
	function outcomeFields(data: any): ToolCallData {
		let r = data.result;
		if (!r || typeof r !== "object" || !r.error)
			return {};
		return r.declined ? { declined: true } : { failed: true };
	}

	// keepEditorRequests: approvals for editor-initiated calls ("ai_onCallTool")
	// do not belong to the chat turn and stay until they are answered.
	function clearApprovals(toolCallId?: string, keepEditorRequests = false) {
		let next: Record<string, Approval> = {};
		for (let id in state.approvals) {
			let a = state.approvals[id];
			let keep = (keepEditorRequests && a.data.source === "editor") ||
				(toolCallId !== undefined && a.toolCallId !== toolCallId);
			if (keep)
				next[id] = a;
		}
		state.approvals = next;
	}

	// ── AI edits ("Undo AI changes" bar) ─────────────────────────────────
	function attachAIEditsSummary(summary: AIEdits) {
		// Only the newest turn can still be undone.
		state.items.forEach((entry) => {
			if (entry.aiEdits && entry.aiEdits.undoAvailable)
				touch(entry).aiEdits = { ...entry.aiEdits, undoAvailable: false };
		});
		let target: Item | null = null;
		for (let i = state.items.length - 1; i >= 0; i--) {
			let entry = state.items[i];
			if (entry.role === "user")
				break;
			if (entry.role === "assistant" && !entry.isToolCall && !entry.error && !entry.aiEdits) {
				target = entry;
				break;
			}
		}
		let edits = { ...summary, busy: false, message: "" };
		if (target)
			touch(target).aiEdits = edits;
		else
			push({ role: "assistant", content: [""], aiEditsOnly: true, aiEdits: edits });
	}

	function applyAIEditsResult(res: any) {
		let item = state.items.slice().reverse().find((i) => i.aiEdits && i.aiEdits.turnId === res.turnId);
		if (!item)
			return;
		item = touch(item);
		let edits: AIEdits = { ...item.aiEdits!, busy: false };
		item.aiEdits = edits;
		if (res.summary) {
			edits.undoAvailable = res.summary.undoAvailable;
			edits.canUndo = res.summary.canUndo;
		}
		if (res.action === "undo") {
			if (res.ok || res.reason === "partial") {
				edits.undone = true;
				edits.message = res.ok ? "" : tr("Only part of the AI changes could be undone.");
			} else if (res.reason === "stale") {
				edits.undoAvailable = false;
				edits.message = tr("Not available: the document was changed by the AI afterwards. Use Undo in the editor.");
			} else {
				edits.message = tr("The AI changes could not be undone.");
			}
		} else {
			edits.revisionCount = typeof res.left === "number" ? res.left : edits.revisionCount;
			edits.undoAvailable = false;
			if (res.reason === "unsupported" || res.reason === "error" || res.reason === "unknown") {
				edits.message = tr("The tracked changes could not be processed. Use the Review tab instead.");
			} else if (res.left > 0) {
				edits.message = fill(tr("%1 changes share a paragraph with other tracked changes. Review them in the Review tab."), res.left);
			} else {
				edits.resolved = res.action;
				edits.message = "";
			}
		}
	}

	// ── Events from the plugin ────────────────────────────────────────────
	const handlers: Record<string, (data: any) => void> = {
		onChatReply(reply) {
			if (state.stopped) {
				finishAgent();
				return;
			}
			let text = typeof reply === "string" ? reply : String(reply ?? "");
			push({ role: "assistant", content: [text], error: text.trim() ? null : ERROR_UNKNOWN });
			finishAgent();
		},

		onChatStreamStart() {
			state.typing = false;
			push({ role: "assistant", content: [""] });
			state.streamingIndex = state.items.length - 1;
		},

		onChatStreamChunk(chunk) {
			if (state.streamingIndex === null || state.stopped)
				return;
			let item = state.items[state.streamingIndex];
			if (!item)
				return;
			item = touch(item);
			item.content = [(item.content as string[])[0] + String(chunk ?? "")];
		},

		onChatStreamEnd() {
			let endsStream = state.streamingIndex !== null;
			state.streamingIndex = null;
			// Text streamed before tool calls ends its stream, not the turn:
			// agentLoop.js always sends a last onChatStreamEnd when the turn ends.
			if (endsStream && !state.stopped)
				return;
			if (state.stopped) {
				let last = state.items[state.items.length - 1];
				if (last && last.isToolCall)
					push({ role: "assistant", content: [tr("Operation was interrupted.")] });
			}
			clearApprovals(undefined, true);
			finishAgent();
		},

		onAttachedText(data) {
			if (data && typeof data === "object" && data.forceSend) {
				sendMessage(String(data.text || "").trim());
				return;
			}
			let text = typeof data === "string" ? data : (data && data.text);
			if (text && String(text).trim()) {
				state.input = String(text);
				state.focusInput++;
			}
		},

		onVoiceInputSupport(isSupported) {
			state.voiceSupported = !!isSupported;
		},

		onUpdateState() {
			try {
				storage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
			} catch (e) {
				// Storage full or blocked: the plugin still waits for the reply.
				console.warn("AI chat: could not save the chat state", e);
			}
			send("onUpdateState");
		},

		// Internal messages of a finished agent turn (tool calls + results).
		// Stored on the user message that started the turn, hidden in the UI,
		// persisted with the chat state and re-sent as history.
		onAgentTranscript(data) {
			if (!data || !data.turnId || !Array.isArray(data.messages))
				return;
			for (let i = state.items.length - 1; i >= 0; i--) {
				let item = state.items[i];
				if (item.role === "user" && item.turnId === data.turnId) {
					let messages = window.AgentHistory.compactTranscript(data.messages);
					if (messages.length > 0)
						item.agentTranscript = { messages, hasFinalReply: !!data.hasFinalReply };
					// Keep the stored chat bounded: transcripts of old turns are dropped.
					window.AgentHistory.pruneTranscripts(state.items);
					return;
				}
			}
		},

		onAgentStatus(data) {
			if (data && data.model)
				state.agentModel = String(data.model);
		},

		onToolCallStart(data) {
			if (!data)
				return;
			let { name, args } = parseCall(data);
			// Editor-initiated calls (toolApproval.js, source "editor") are not
			// part of the agent turn and leave the status line alone.
			if (state.running && data.source !== "editor") {
				state.activeTool = summaryFields(data).summary || data.humanName || name;
				statusToolId = data.id || null;
			}
			let index = addToolCall({ functionName: name, humanName: data.humanName || name, arguments: args, result: null, ...summaryFields(data) }, data.source);
			if (data.id)
				toolCallIndices[data.id] = index;
		},

		onToolCallEnd(data) {
			if (!data)
				return;
			let result = parseResult(data);
			if (data.source !== "editor" && (data.id || null) === statusToolId) {
				state.activeTool = null;
				statusToolId = null;
			}
			if (data.id)
				clearApprovals(data.id);
			if (data.id && toolCallIndices[data.id] !== undefined) {
				updateToolCallResult(toolCallIndices[data.id], result, { ...summaryFields(data), ...outcomeFields(data) });
				delete toolCallIndices[data.id];
			}
		},

		// Deprecated single event (start + result), kept for older plugins.
		onToolCall(data) {
			if (!data)
				return;
			let { name, args } = parseCall(data);
			addToolCall({ functionName: name, humanName: data.humanName || name, arguments: args, result: parseResult(data), ...summaryFields(data), ...outcomeFields(data) });
		},

		onToolApprovalRequest(data) {
			if (!data || !data.id)
				return;
			let index = data.toolCallId ? toolCallIndices[data.toolCallId] : undefined;
			if (index === undefined)
				index = addToolCall({ functionName: data.functionName, humanName: data.humanName || data.functionName, arguments: data.arguments || "", result: null, ...summaryFields(data) }, data.source);
			state.approvals = { ...state.approvals, [data.id]: { data, toolCallId: data.toolCallId, itemId: index.itemId } };
		},

		onAIEditsSummary(summary) {
			if (summary && summary.turnId)
				attachAIEditsSummary(summary);
		},

		onAIEditsActionResult(res) {
			if (res && res.turnId)
				applyAIEditsResult(res);
		},

		onSelectionSuggestions(data) {
			if (!data || typeof data !== "object")
				return;
			state.chips = {
				key: String(data.key || ""),
				summary: String(data.summary || ""),
				actions: Array.isArray(data.actions) ? data.actions.filter((a: any) => a && a.id && a.text) : []
			};
			if (state.chips.key !== state.chipsDismissedKey)
				state.chipsDismissedKey = null;
		},

		onThemeChanged(theme: Theme) {
			if (!theme)
				return;
			plugin.onThemeChangedBase && plugin.onThemeChangedBase(theme);
			state.themeType = theme.type === "dark" ? "dark" : "light";
			window.updateBodyThemeClasses && window.updateBodyThemeClasses(theme.type, theme.name);
			window.updateThemeVariables && window.updateThemeVariables(theme);
			// Non-standard themes use the editor's compact corner radius.
			state.compactRadius = theme.name !== "theme-white" && theme.name !== "theme-night";
		}
	};

	// ── Actions from the UI ──────────────────────────────────────────────
	const actions = {
		setInput(value: string, focus = false) {
			state.input = value;
			if (focus)
				state.focusInput++;
			changed();
		},

		submit() {
			if (state.running)
				return;
			let value = state.input.trim();
			if (!value)
				return;
			state.input = "";
			sendMessage(value);
		},

		stop() {
			state.stopped = true;
			clearApprovals(); // the plugin side resolves pending approvals as denied
			send("onStopAgent", {});
			changed();
		},

		// Sends the last question again ("Update").
		regenerate() {
			if (state.running)
				return;
			for (let i = state.items.length - 1; i >= 0; i--) {
				if (state.items[i].role === "user") {
					sendMessage(state.items[i].content as string);
					return;
				}
			}
		},

		// Removes the turn the item belongs to: its question, the tool calls
		// and the answers, so the history sent next stays consistent.
		deleteTurn(item: Item) {
			if (state.running)
				return;
			let i = state.items.indexOf(item);
			if (i < 0)
				return;
			let start = i;
			while (start > 0 && state.items[start].role !== "user")
				start--;
			let end = i + 1;
			while (end < state.items.length && state.items[end].role !== "user")
				end++;
			state.items = state.items.slice(0, start).concat(state.items.slice(end));
			changed();
		},

		clearHistory() {
			state.items = [];
			changed();
		},

		insert(type: string, data: string) {
			send("onChatReplace", { type, data });
		},

		respondApproval(id: string, decision: string) {
			if (!state.approvals[id])
				return;
			let next = { ...state.approvals };
			delete next[id];
			state.approvals = next;
			send("onToolApprovalResponse", { id, decision });
			changed();
		},

		aiEditsAction(item: Item, action: string) {
			if (!item.aiEdits || item.aiEdits.busy)
				return;
			touch(item).aiEdits = { ...item.aiEdits, busy: true, message: "" };
			send("onAIEditsAction", { turnId: item.aiEdits.turnId, action });
			changed();
		},

		navigate(href: string) {
			// Never navigate the frame; only valid locations, not while the agent runs.
			if (!state.running && window.EOLinks.parse(href))
				send("onNavigate", { href });
		},

		chip(id: string) {
			// Hidden right away; the agent run keeps them hidden until it ends.
			setChipsBusy(true, true);
			send("onSmartActionChip", { id });
			state.focusInput++;
			changed();
		},

		dismissChips() {
			if (state.chips)
				state.chipsDismissedKey = state.chips.key;
			state.focusInput++;
			changed();
		},

		clearAttachedText() {
			state.attachedText = "";
			changed();
		},

		setRecording(recording: boolean) {
			state.recording = recording;
			changed();
		},

		setError,
		clearError
	};

	return {
		state,
		tr,
		actions,
		handlers,
		chipsVisible,
		restore,
		setTranslations(map: Record<string, string>) {
			translations = map || {};
			state.trVersion++;
			changed();
		},
		changed,
		subscribe(f: () => void) {
			listeners.push(f);
			return () => { listeners = listeners.filter((l) => l !== f); };
		},
		// Registers the plugin events; each one re-renders.
		attach() {
			for (let name in handlers) {
				plugin.attachEvent(name, (data: any) => {
					handlers[name](data);
					changed();
				});
			}
		}
	};
}

export type Chat = ReturnType<typeof createChat>;
