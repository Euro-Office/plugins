// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Chat history with tool context.
//
// After each agent turn the plugin sends the turn's internal messages
// (assistant messages with tool_calls, tool results, prompt-based
// "[functionCalling ...]" / "SYSTEM:" exchanges) to the chat, which stores
// them on the user message that started the turn ("agentTranscript"). When
// the next message is sent, build() turns the chat items back into a valid
// request history, so the model remembers what it read and changed:
//
//   user, [assistant(tool_calls), tool, tool, ...]*, assistant(final reply)
//
// Budget: tool results and arguments are truncated, only the last
// HISTORY_FULL_TOOL_TURNS turns keep the full tool exchange, older turns
// collapse into a one-line summary in front of their reply, and only the
// last HISTORY_STORED_TRANSCRIPT_TURNS user turns keep a transcript at all
// (pruneTranscripts).
//
// flatten() rewrites tool exchanges as plain assistant/user text for models
// or providers that can not take tool messages (prompt-based function
// calling, providers without tool message support).
//
// Pure logic (no DOM, no editor API), loaded in sidebar/index.html and index.html and
// testable in Node.
(function(root) {

	// Max characters of one tool result / prompt-based "SYSTEM:" result kept.
	const HISTORY_TOOL_RESULT_MAX_CHARS = 2000;
	// Max characters of the JSON arguments of one tool call kept.
	const HISTORY_TOOL_ARGS_MAX_CHARS = 2000;
	// Number of most recent turns (with tool use) that keep the full exchange.
	const HISTORY_FULL_TOOL_TURNS = 3;
	// Max tool names listed in the summary of an older turn.
	const HISTORY_SUMMARY_MAX_TOOLS = 10;
	// Number of most recent user turns whose transcript is stored with the
	// chat. Older transcripts are dropped from the chat state (their turns
	// are sent as plain user/assistant text, without the tool summary), so
	// the persisted chat does not grow with every tool result.
	const HISTORY_STORED_TRANSCRIPT_TURNS = 10;

	const FUNC_CALL_RE = /^\s*\[functionCalling\s*\(\s*([A-Za-z_$][\w$.-]*)\s*\)\s*\]\s*:?\s*([\s\S]*)$/;
	const MISSING_RESULT = "No result was recorded for this call.";

	function truncate(text, max) {
		text = (text === undefined || text === null) ? "" : String(text);
		if (text.length <= max)
			return text;
		return text.substring(0, max) + "\n[truncated " + (text.length - max) + " chars]";
	}

	// Arguments must stay valid JSON (some providers parse them), so long
	// arguments are replaced by a JSON object holding a truncated preview.
	function truncateArgs(args) {
		if (typeof args !== "string")
			args = JSON.stringify(args === undefined || args === null ? {} : args);
		if (args.length <= HISTORY_TOOL_ARGS_MAX_CHARS)
			return args;
		return JSON.stringify({
			_truncated: args.substring(0, HISTORY_TOOL_ARGS_MAX_CHARS) + " [truncated " + (args.length - HISTORY_TOOL_ARGS_MAX_CHARS) + " chars]"
		});
	}

	function toolName(toolCall) {
		return (toolCall && toolCall.function && toolCall.function.name) ? String(toolCall.function.name) : "";
	}

	// Copies the messages of one agent turn into the compact stored form:
	// only the fields providers need, long texts truncated. Unknown shapes
	// are dropped. Used when the transcript arrives and again in build().
	function compactTranscript(messages) {
		let out = [];
		if (!Array.isArray(messages))
			return out;
		for (let i = 0; i < messages.length; i++) {
			let msg = messages[i];
			if (!msg || typeof msg !== "object")
				continue;
			if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
				let calls = [];
				for (let j = 0; j < msg.tool_calls.length; j++) {
					let tc = msg.tool_calls[j];
					if (!tc || !tc.id)
						continue;
					calls.push({
						id: String(tc.id),
						type: "function",
						function: {
							name: toolName(tc),
							arguments: truncateArgs(tc.function ? tc.function.arguments : "{}")
						}
					});
				}
				if (calls.length > 0)
					out.push({ role: "assistant", content: msg.content ? truncate(msg.content, HISTORY_TOOL_RESULT_MAX_CHARS) : null, tool_calls: calls });
			} else if (msg.role === "tool" && msg.tool_call_id) {
				out.push({ role: "tool", tool_call_id: String(msg.tool_call_id), content: truncate(msg.content, HISTORY_TOOL_RESULT_MAX_CHARS) });
			} else if ((msg.role === "assistant" || msg.role === "user") && typeof msg.content === "string") {
				out.push({ role: msg.role, content: truncate(msg.content, HISTORY_TOOL_RESULT_MAX_CHARS) });
			}
		}
		return out;
	}

	// Makes a message list valid for tool-capable APIs: every assistant
	// message with tool_calls is followed by exactly one tool message per
	// call, in call order. Missing results are filled in, tool messages
	// without a matching call (orphans) and duplicates are dropped.
	function sanitize(messages) {
		let out = [];
		let i = 0;
		while (i < messages.length) {
			let msg = messages[i];
			if (msg.role === "tool") {
				i++; // orphan: no assistant tool_calls message right before it
				continue;
			}
			if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
				let results = {};
				let j = i + 1;
				while (j < messages.length && messages[j].role === "tool") {
					if (results[messages[j].tool_call_id] === undefined)
						results[messages[j].tool_call_id] = messages[j];
					j++;
				}
				out.push(msg);
				for (let k = 0; k < msg.tool_calls.length; k++) {
					let id = msg.tool_calls[k].id;
					out.push(results[id] || { role: "tool", tool_call_id: id, content: MISSING_RESULT });
				}
				i = j;
				continue;
			}
			if (msg.role === "assistant" && (msg.content === null || msg.content === undefined || String(msg.content).trim() === "")) {
				i++; // empty assistant text is rejected by some providers
				continue;
			}
			out.push(msg);
			i++;
		}
		return out;
	}

	// Tool names called in a transcript (native and prompt-based).
	function toolNamesOf(messages) {
		let names = [];
		for (let i = 0; Array.isArray(messages) && i < messages.length; i++) {
			let msg = messages[i];
			if (msg.role !== "assistant")
				continue;
			if (Array.isArray(msg.tool_calls)) {
				for (let j = 0; j < msg.tool_calls.length; j++) {
					let name = toolName(msg.tool_calls[j]);
					if (name)
						names.push(name);
				}
			} else if (typeof msg.content === "string") {
				let m = FUNC_CALL_RE.exec(msg.content);
				if (m)
					names.push(m[1]);
			}
		}
		return names;
	}

	// One line for an older turn, e.g. "[Tools used in this step: readRange ×2, addChart]"
	function summarize(messages) {
		let names = toolNamesOf(messages);
		if (names.length === 0)
			return "";
		let counts = {};
		let order = [];
		for (let i = 0; i < names.length; i++) {
			if (!counts[names[i]]) {
				counts[names[i]] = 0;
				order.push(names[i]);
			}
			counts[names[i]]++;
		}
		let parts = order.slice(0, HISTORY_SUMMARY_MAX_TOOLS).map(function(n) {
			return counts[n] > 1 ? n + " ×" + counts[n] : n;
		});
		if (order.length > HISTORY_SUMMARY_MAX_TOOLS)
			parts.push("…");
		return "[Tools used in this step (details omitted): " + parts.join(", ") + "]";
	}

	function itemText(item) {
		if (item.role === "user")
			return typeof item.content === "string" ? item.content : "";
		if (Array.isArray(item.content)) {
			let idx = item.activeContentIndex || 0;
			let text = item.content[idx] !== undefined ? item.content[idx] : item.content[0];
			return typeof text === "string" ? text : "";
		}
		return typeof item.content === "string" ? item.content : "";
	}

	function isToolItem(item) {
		return !!(item.isToolCall || item.role === "tool");
	}

	function hasTranscript(turn) {
		return !!(turn.user && turn.user.agentTranscript && Array.isArray(turn.user.agentTranscript.messages) &&
			turn.user.agentTranscript.messages.length > 0);
	}

	// Splits chat items into turns: a user message and everything after it
	// until the next user message.
	function splitTurns(items) {
		let turns = [];
		let current = { user: null, items: [] };
		for (let i = 0; i < items.length; i++) {
			let item = items[i];
			if (!item)
				continue;
			if (item.role === "user" && !isToolItem(item)) {
				if (current.user || current.items.length)
					turns.push(current);
				current = { user: item, items: [] };
			} else {
				current.items.push(item);
			}
		}
		if (current.user || current.items.length)
			turns.push(current);
		return turns;
	}

	// items: chat items as stored by the chat sidebar (user: content string;
	// assistant: content array + activeContentIndex; tool UI items with
	// isToolCall; errors with item.error; user items may carry agentTranscript).
	// Returns the request history (without system prompt).
	function build(items) {
		let turns = splitTurns(Array.isArray(items) ? items : []);

		// A turn that ended in an error is dropped as a whole (the error item,
		// the user message that caused it and any tool exchange in between).
		turns = turns.filter(function(turn) {
			for (let i = 0; i < turn.items.length; i++) {
				if (turn.items[i].error)
					return false;
			}
			return true;
		});

		// The most recent turns with tool use keep the full exchange.
		let fullTurns = 0;
		for (let t = turns.length - 1; t >= 0; t--) {
			if (hasTranscript(turns[t])) {
				turns[t].full = fullTurns < HISTORY_FULL_TOOL_TURNS;
				fullTurns++;
			}
		}

		let messages = [];
		for (let t = 0; t < turns.length; t++) {
			let turn = turns[t];
			if (turn.user)
				messages.push({ role: "user", content: itemText(turn.user) });

			let replies = turn.items.filter(function(item) { return !isToolItem(item) && item.role === "assistant"; });

			if (!hasTranscript(turn)) {
				// No tool context recorded (plain chat or older saved state).
				for (let i = 0; i < replies.length; i++)
					messages.push({ role: "assistant", content: itemText(replies[i]) });
				continue;
			}

			let transcript = turn.user.agentTranscript;
			// Intermediate assistant texts are already part of the transcript;
			// only the final reply (the last assistant item) is added.
			let finalReply = (transcript.hasFinalReply && replies.length > 0) ? itemText(replies[replies.length - 1]) : "";

			if (turn.full) {
				let compact = sanitize(compactTranscript(transcript.messages));
				for (let i = 0; i < compact.length; i++)
					messages.push(compact[i]);
				if (finalReply.trim())
					messages.push({ role: "assistant", content: finalReply });
			} else {
				let summary = summarize(transcript.messages);
				let content = [summary, finalReply].filter(function(s) { return s && s.trim(); }).join("\n\n");
				if (content)
					messages.push({ role: "assistant", content: content });
			}
		}
		return sanitize(messages);
	}

	// Names of all tools used in the chat (tool UI items and transcripts),
	// used to keep their categories loaded in later requests.
	function collectToolNames(items) {
		let seen = {};
		let names = [];
		function add(name) {
			if (name && !seen[name]) {
				seen[name] = true;
				names.push(name);
			}
		}
		for (let i = 0; Array.isArray(items) && i < items.length; i++) {
			let item = items[i];
			if (!item)
				continue;
			if (item.isToolCall) {
				add(item.functionName);
				// One card groups consecutive calls of different tools.
				(Array.isArray(item.calls) ? item.calls : []).forEach(function(call) { add(call && call.functionName); });
			}
			if (item.agentTranscript)
				toolNamesOf(item.agentTranscript.messages).forEach(add);
		}
		return names;
	}

	// Drops the stored transcripts of all but the last `keepTurns` user
	// turns (default HISTORY_STORED_TRANSCRIPT_TURNS). Changes the items in
	// place; returns the number of transcripts removed.
	function pruneTranscripts(items, keepTurns) {
		if (!Array.isArray(items))
			return 0;
		if (typeof keepTurns !== "number" || keepTurns < 0)
			keepTurns = HISTORY_STORED_TRANSCRIPT_TURNS;
		let userTurns = 0;
		let removed = 0;
		for (let i = items.length - 1; i >= 0; i--) {
			let item = items[i];
			if (!item || item.role !== "user" || isToolItem(item))
				continue;
			userTurns++;
			if (userTurns > keepTurns && item.agentTranscript) {
				delete item.agentTranscript;
				removed++;
			}
		}
		return removed;
	}

	// Rewrites tool exchanges as plain text in the prompt-based format:
	//   assistant: "[functionCalling (name)]: {args}"
	//   user:      "SYSTEM: Result of name: ..."
	// and merges consecutive messages of the same role.
	function flatten(messages) {
		let names = {};
		let out = [];
		function push(role, content) {
			let prev = out.length ? out[out.length - 1] : null;
			if (prev && prev.role === role && prev.role !== "system")
				prev.content = prev.content + "\n\n" + content;
			else
				out.push({ role: role, content: content });
		}
		for (let i = 0; i < messages.length; i++) {
			let msg = messages[i];
			if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
				let lines = [];
				if (msg.content)
					lines.push(String(msg.content));
				for (let j = 0; j < msg.tool_calls.length; j++) {
					let tc = msg.tool_calls[j];
					names[tc.id] = toolName(tc);
					let args = tc.function ? tc.function.arguments : "{}";
					lines.push("[functionCalling (" + toolName(tc) + ")]: " + (typeof args === "string" ? args : JSON.stringify(args || {})));
				}
				push("assistant", lines.join("\n"));
			} else if (msg.role === "tool") {
				let name = names[msg.tool_call_id] || "tool";
				push("user", "SYSTEM: Result of " + name + ":\n" + (msg.content || ""));
			} else {
				let content = (msg.content === null || msg.content === undefined) ? "" : msg.content;
				if (msg.role === "assistant" && String(content).trim() === "")
					continue;
				push(msg.role, content);
			}
		}
		return out;
	}

	let api = {
		HISTORY_TOOL_RESULT_MAX_CHARS: HISTORY_TOOL_RESULT_MAX_CHARS,
		HISTORY_TOOL_ARGS_MAX_CHARS: HISTORY_TOOL_ARGS_MAX_CHARS,
		HISTORY_FULL_TOOL_TURNS: HISTORY_FULL_TOOL_TURNS,
		HISTORY_SUMMARY_MAX_TOOLS: HISTORY_SUMMARY_MAX_TOOLS,
		HISTORY_STORED_TRANSCRIPT_TURNS: HISTORY_STORED_TRANSCRIPT_TURNS,
		truncate: truncate,
		compactTranscript: compactTranscript,
		sanitize: sanitize,
		summarize: summarize,
		build: build,
		flatten: flatten,
		collectToolNames: collectToolNames,
		pruneTranscripts: pruneTranscripts
	};

	root.AgentHistory = api;
	if (typeof module === "object" && module.exports)
		module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
