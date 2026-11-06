// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Tool approval shared by the two ways a tool can be called:
//  1. the chat agent (scripts/engine/agentLoop.js, onChatMessage), and
//  2. the editor event "ai_onCallTool" (scripts/code.js), sent by an external
//     host through the DocsAPI connector (see handleEditorToolCall below).
//
// Rules (the same for both paths):
//  - tools marked readOnly (RegisteredFunction.readOnly) run without asking;
//  - every other tool needs the user's consent in the chat window
//    ("Allow" / "Always allow" / "Deny"). "Always allow" is stored per tool
//    in localStorage, except for writeMacro (arbitrary code), where it only
//    lasts as long as the chat window is open;
//  - arguments are parsed as data (parseToolArguments in helperFuncs.js),
//    never evaluated;
//  - unknown tools and bad arguments become error results, never throws.
//
// The approval card is shown in the chat window. For editor-initiated calls
// the chat window is opened/activated if needed (window.chatWindowShow); if
// that is impossible the call is denied with an error result.
(function(root) {

	const ALWAYS_ALLOW_KEY = "onlyoffice_ai_tool_always_allow";
	const SESSION_ONLY_TOOLS = { "writeMacro": true };
	const WINDOW_READY_TIMEOUT = 20000;
	const PREVIEW_TIMEOUT = 4000;
	const DECLINED_MESSAGE = "The user declined this action.";

	let sessionAllowedTools = {};
	let pendingApprovals = {};
	let approvalCounter = 0;
	let editorCallCounter = 0;

	// The chat window approvals are shown in, and whether it has loaded.
	let boundWindow = null;
	let windowReady = false;
	let readyWaiters = [];

	function tr(text) {
		try {
			if (root.Asc && root.Asc.plugin && typeof root.Asc.plugin.tr === "function")
				return root.Asc.plugin.tr(text);
		} catch (e) {}
		return text;
	}

	function declinedMessage() {
		return (typeof root.TOOL_DECLINED_MESSAGE === "string") ? root.TOOL_DECLINED_MESSAGE : DECLINED_MESSAGE;
	}

	function getHelper() {
		if (!root.EditorHelper && typeof root.EditorHelperImpl === "function")
			root.EditorHelper = new root.EditorHelperImpl();
		return root.EditorHelper || null;
	}

	function getFunc(name) {
		let helper = getHelper();
		if (!helper || !helper.names2funcs || typeof name !== "string" || !name)
			return null;
		if (!Object.prototype.hasOwnProperty.call(helper.names2funcs, name))
			return null;
		return helper.names2funcs[name] || null;
	}

	function isReadOnly(name) {
		let func = getFunc(name);
		return !!(func && func.readOnly === true);
	}

	// Plain-language sentences for the chat (EditorHelper.describeToolCall);
	// {} when unavailable.
	function describe(name, args, outcome) {
		let helper = getHelper();
		try {
			return (helper && typeof helper.describeToolCall === "function") ? helper.describeToolCall(name, args, outcome) : {};
		} catch (e) {
			return {};
		}
	}

	function humanName(name) {
		let helper = getHelper();
		return (helper && typeof helper.getHumanName === "function") ? helper.getHumanName(name) : name;
	}

	// ── Permissions ────────────────────────────────────────────────────────

	function getPersistedAllowedTools() {
		try {
			let value = JSON.parse(root.localStorage.getItem(ALWAYS_ALLOW_KEY) || "{}");
			return (value && typeof value === "object" && !Array.isArray(value)) ? value : {};
		} catch (e) {
			return {};
		}
	}

	function rememberAllowedTool(name) {
		if (SESSION_ONLY_TOOLS[name]) {
			sessionAllowedTools[name] = true;
			return;
		}
		let allowed = getPersistedAllowedTools();
		allowed[name] = true;
		try {
			root.localStorage.setItem(ALWAYS_ALLOW_KEY, JSON.stringify(allowed));
		} catch (e) {
			sessionAllowedTools[name] = true;
		}
	}

	function isPreapproved(name) {
		if (isReadOnly(name))
			return true;
		if (sessionAllowedTools[name])
			return true;
		if (SESSION_ONLY_TOOLS[name])
			return false;
		return getPersistedAllowedTools()[name] === true;
	}

	// ── Chat window binding ────────────────────────────────────────────────

	function settleWaiters(value) {
		let waiters = readyWaiters;
		readyWaiters = [];
		for (let i = 0; i < waiters.length; i++)
			waiters[i](value);
	}

	// Called when a chat window is created. A new window is a new approval
	// session: session-only permissions start empty.
	function bindWindow(win) {
		if (boundWindow === win)
			return;
		denyAll();
		settleWaiters(false);
		boundWindow = win || null;
		windowReady = false;
		sessionAllowedTools = {};
	}

	function setWindowReady(win) {
		if (!win || win !== boundWindow)
			return;
		windowReady = true;
		settleWaiters(true);
	}

	// Called when the chat window is closed: pending approvals are denied.
	function unbindWindow(win) {
		if (win && win !== boundWindow)
			return;
		denyAll();
		boundWindow = null;
		windowReady = false;
		sessionAllowedTools = {};
		settleWaiters(false);
	}

	function currentWindow() {
		if (!boundWindow)
			return null;
		// window.chatWindow is deleted when the chat is closed (code.js).
		if (root.chatWindow !== boundWindow)
			return null;
		return boundWindow;
	}

	function waitForWindow(timeout) {
		if (currentWindow() && windowReady)
			return Promise.resolve(true);
		if (!boundWindow)
			return Promise.resolve(false);
		return new Promise(function(resolve) {
			let done = false;
			let timer = setTimeout(function() {
				finish(false);
			}, timeout || WINDOW_READY_TIMEOUT);
			function finish(value) {
				if (done)
					return;
				done = true;
				clearTimeout(timer);
				let i = readyWaiters.indexOf(finish);
				if (i !== -1)
					readyWaiters.splice(i, 1);
				resolve(value && !!currentWindow());
			}
			readyWaiters.push(finish);
		});
	}

	// Opens or activates the chat window so an approval card can be shown.
	async function ensureWindow() {
		try {
			if (typeof root.chatWindowShow === "function")
				root.chatWindowShow();
		} catch (e) {
			console.error("Could not open the chat window for a tool approval:", e);
		}
		return await waitForWindow(WINDOW_READY_TIMEOUT);
	}

	// ── Previews ───────────────────────────────────────────────────────────

	// Optional before/after preview of a writing tool (RegisteredFunction.preview,
	// see scripts/helpers/toolPreviews.js). Never throws; null when unavailable.
	async function getPreview(name, args) {
		let func = getFunc(name);
		if (!func || typeof func.preview !== "function")
			return null;
		try {
			let timer = null;
			let timeout = new Promise(function(resolve) {
				timer = setTimeout(function() { resolve(null); }, PREVIEW_TIMEOUT);
			});
			let result = await Promise.race([Promise.resolve().then(function() { return func.preview(args || {}); }), timeout]);
			clearTimeout(timer);
			if (!result || typeof result !== "object")
				return null;
			// Only plain data crosses into the chat window.
			return JSON.parse(JSON.stringify(result));
		} catch (e) {
			console.warn("Tool preview failed for " + name + ":", e);
			return null;
		}
	}

	// ── Approval requests ──────────────────────────────────────────────────

	// Resolves true if the tool may run. False if the user declined, the chat
	// window is not available or went away, or the agent was stopped.
	// opts: { toolCallId, functionName, args, source: "chat"|"editor", preview? }
	async function request(opts) {
		opts = opts || {};
		let name = opts.functionName;
		if (isPreapproved(name))
			return true;

		let preview = opts.preview !== undefined ? opts.preview : await getPreview(name, opts.args);

		let win = currentWindow();
		if (!win || !windowReady)
			return false;

		let id = "approval_" + (++approvalCounter) + "_" + (opts.toolCallId || "");
		return await new Promise(function(resolve) {
			pendingApprovals[id] = { resolve: resolve, functionName: name, source: opts.source || "chat" };
			let data = {
				id: id,
				toolCallId: opts.toolCallId,
				functionName: name,
				humanName: humanName(name),
				summary: describe(name, opts.args).summary,
				arguments: JSON.stringify(opts.args || {}, null, 2),
				source: opts.source || "chat"
			};
			if (name === "writeMacro" && opts.args && typeof opts.args.code === "string")
				data.code = opts.args.code;
			if (preview)
				data.preview = preview;
			try {
				win.command("onToolApprovalRequest", data);
			} catch (e) {
				console.error("Failed to request tool approval:", e);
				delete pendingApprovals[id];
				resolve(false);
			}
		});
	}

	// data: { id, decision: "allow"|"always"|"deny" }. When the chat agent was
	// stopped, its own pending approvals resolve as denied.
	function respond(data, isAgentStopped) {
		if (!data || !data.id || !pendingApprovals[data.id])
			return false;
		let pending = pendingApprovals[data.id];
		delete pendingApprovals[data.id];

		let allowed = data.decision === "allow" || data.decision === "always";
		if (pending.source === "chat" && isAgentStopped)
			allowed = false;
		if (allowed && data.decision === "always")
			rememberAllowedTool(pending.functionName);
		pending.resolve(allowed);
		return true;
	}

	function denyAll() {
		let ids = Object.keys(pendingApprovals);
		for (let i = 0; i < ids.length; i++) {
			let pending = pendingApprovals[ids[i]];
			delete pendingApprovals[ids[i]];
			pending.resolve(false);
		}
	}

	function hasPending() {
		return Object.keys(pendingApprovals).length > 0;
	}

	// ── Editor-initiated tool calls ("ai_onCallTool") ───────────────────────

	// Tools throw window.AgentState.ToolError; make sure it exists even when the
	// chat window (which creates AgentState) was never opened.
	function ensureToolError() {
		if (root.AgentState && root.AgentState.ToolError)
			return;
		class ToolError extends Error {
			constructor(message) {
				super(message);
				this.name = "ToolError";
			}
		}
		root.AgentState = root.AgentState || { isStopped: false };
		root.AgentState.ToolError = ToolError;
	}

	function parseArguments(raw) {
		try {
			if (typeof root.parseToolArguments === "function")
				return { args: root.parseToolArguments(raw) };
			if (raw === undefined || raw === null || raw === "")
				return { args: {} };
			let value = (typeof raw === "string") ? JSON.parse(raw) : raw;
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("expected a JSON object");
			return { args: value };
		} catch (e) {
			return { error: (e && e.message) ? e.message : String(e) };
		}
	}

	// Runs a tool, recording writes (AIEdits: one undo step, tracked changes;
	// AIProvenance: content marking) when those modules are loaded.
	function runTool(func, name, args) {
		let readOnly = func.readOnly === true;
		let call = function() { return func.call(args); };
		let marked = call;
		if (root.AIProvenance && typeof root.AIProvenance.runTool === "function")
			marked = function() { return root.AIProvenance.runTool(name, readOnly, null, call); };
		if (root.AIEdits && typeof root.AIEdits.runTool === "function")
			return root.AIEdits.runTool(name, readOnly, marked, { author: "AI", noTurn: true });
		if (readOnly)
			return marked();
		return runGrouped(marked);
	}

	// One undo step for a write when AIEdits is not loaded.
	async function runGrouped(fn) {
		let editor = root.Asc && root.Asc.Editor;
		await editor.callMethod("StartAction", ["GroupActions"]);
		try {
			return await fn();
		} finally {
			await editor.callMethod("EndAction", ["GroupActions"]);
		}
	}

	function toResult(value, name) {
		let result;
		if (value && typeof value === "object" && !Array.isArray(value))
			result = Object.assign({}, value);
		else if (value === undefined || value === null)
			result = {};
		else
			result = { result: value };
		result.message = "System function '" + name + "' executed successfully";
		return result;
	}

	// Handles the editor event "ai_onCallTool".
	//
	// Who sends it: nothing inside sdkjs. An external host (for example the
	// DocSpace AI agent) registers a DocsAPI connector
	// (docEditor.createConnector()) and calls connector.sendEvent("ai_onCallTool",
	// { name, arguments }). sdkjs routes connector messages through
	// common/editorscommon.js (postMessage "subType": "connector" ->
	// g_asc_plugins.externalConnectorMessage, common/plugins.js) to the
	// "SendEvent" plugin method (common/plugins.js, case "method":
	// SendEvent -> onPluginEvent), which delivers it to every running plugin
	// that attached the event (this plugin: attachEditorEvent in code.js).
	// The result goes back the same way: Asc.plugin.sendEvent("ai_onCallToolResult",
	// result) -> SendEvent -> the connector, which attached "ai_onCallToolResult".
	// Paths/lines refer to Euro-Office/sdkjs.
	//
	// The caller is outside the plugin and not trusted to have asked the user:
	// the same approval rules as for the chat agent apply.
	async function handleEditorToolCall(toolCall) {
		ensureToolError();

		let name = (toolCall && typeof toolCall.name === "string") ? toolCall.name : "";
		let func = getFunc(name);
		if (!func || typeof func.call !== "function") {
			let helper = getHelper();
			let available = helper && helper.names2funcs ? Object.keys(helper.names2funcs).join(", ") : "";
			return { error: "Unknown tool \"" + name + "\"." + (available ? " Available tools: " + available : "") };
		}

		let parsed = parseArguments(toolCall ? toolCall.arguments : null);
		if (parsed.error)
			return { error: "Arguments for \"" + name + "\" are not valid JSON (" + parsed.error + "). The tool was not run." };
		let args = parsed.args;

		let toolCallId = "editor_" + (++editorCallCounter) + "_" + Date.now();
		let win = null;

		if (!isPreapproved(name)) {
			if (!(await ensureWindow())) {
				return {
					error: "This tool changes the document and needs the user's approval, but the AI chat window could not be opened. The tool was not run.",
					declined: true
				};
			}
			win = currentWindow();
			try {
				win.command("onToolCallStart", Object.assign({
					type: "native",
					id: toolCallId,
					functionName: name,
					humanName: humanName(name),
					arguments: JSON.stringify(args, null, 2),
					source: "editor"
				}, describe(name, args)));
			} catch (e) {}

			let allowed = await request({ toolCallId: toolCallId, functionName: name, args: args, source: "editor" });
			if (!allowed) {
				let declined = { error: declinedMessage(), declined: true };
				notifyEnd(win, toolCallId, name, args, declined, { error: declined.error, declined: true });
				return declined;
			}
		}

		let result;
		let outcome;
		try {
			let editor = root.Asc && root.Asc.Editor;
			let run = (editor && editor.runIsolated)
				? await editor.runIsolated(function() { return runTool(func, name, args); })
				: { value: await runTool(func, name, args), errors: [] };
			if (run.errors.length)
				throw new Error("The editor reported an error, the action may be incomplete: " + run.errors[run.errors.length - 1]);
			let value = run.value;
			outcome = { result: value };
			result = toResult(value, name);
		} catch (e) {
			let detail = (e && e.message) ? e.message : String(e);
			console.error("Error calling function: " + name, e);
			outcome = { error: detail };
			result = { error: "Error calling function: " + name + ": " + detail };
		}

		if (win)
			notifyEnd(win, toolCallId, name, args, result, outcome);
		return result;
	}

	function notifyEnd(win, toolCallId, name, args, result, outcome) {
		try {
			win.command("onToolCallEnd", Object.assign({
				type: "native",
				id: toolCallId,
				functionName: name,
				arguments: JSON.stringify(args || {}, null, 2),
				result: result,
				source: "editor"
			}, describe(name, args, outcome)));
		} catch (e) {}
	}

	root.ToolApproval = {
		ALWAYS_ALLOW_KEY: ALWAYS_ALLOW_KEY,
		SESSION_ONLY_TOOLS: SESSION_ONLY_TOOLS,

		isReadOnly: isReadOnly,
		isPreapproved: isPreapproved,
		rememberAllowedTool: rememberAllowedTool,

		bindWindow: bindWindow,
		setWindowReady: setWindowReady,
		unbindWindow: unbindWindow,
		currentWindow: currentWindow,
		ensureWindow: ensureWindow,

		getPreview: getPreview,
		request: request,
		respond: respond,
		denyAll: denyAll,
		hasPending: hasPending,

		parseArguments: parseArguments,
		handleEditorToolCall: handleEditorToolCall,
		tr: tr
	};

})(typeof window !== "undefined" ? window : globalThis);
