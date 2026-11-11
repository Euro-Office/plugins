// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Agent history across turns (scripts/helpers/agentHistory.js)
// (ported from the standalone node:test suite that came with the feature).

import { test } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { PLUGIN_DIR as AI_DIR } from "../lib/sandbox.js";

const require = createRequire(import.meta.url);
const H = require(path.join(AI_DIR, "scripts/helpers/agentHistory.js"));

// Every assistant tool_calls message is followed by exactly its tool messages, in order.
function assertValid(messages) {
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "tool") {
			// must belong to the nearest preceding assistant tool_calls run
			let j = i - 1;
			while (j >= 0 && messages[j].role === "tool") j--;
			assert.ok(j >= 0 && messages[j].role === "assistant" && messages[j].tool_calls, "orphan tool message at " + i);
		}
		if (m.role === "assistant" && m.tool_calls) {
			const ids = m.tool_calls.map((t) => t.id);
			const results = [];
			let k = i + 1;
			while (k < messages.length && messages[k].role === "tool") results.push(messages[k++].tool_call_id);
			assert.deepStrictEqual(results, ids, "tool results must match calls at " + i);
		}
		if (m.role === "assistant" && !m.tool_calls)
			assert.ok(String(m.content || "").trim() !== "", "empty assistant text at " + i);
	}
}

function call(id, name, args) {
	return { id, type: "function", function: { name, arguments: JSON.stringify(args || {}) } };
}
function user(text, transcript, turnId) {
	const u = { role: "user", content: text, turnId };
	if (transcript) u.agentTranscript = transcript;
	return u;
}
function reply(text, extra) { return Object.assign({ role: "assistant", content: [text], activeContentIndex: 0 }, extra || {}); }
function toolItem(name) { return { role: "tool", isToolCall: true, functionName: name, calls: [] }; }

function nativeTurn(n, resultText) {
	return {
		hasFinalReply: true,
		messages: [
			{ role: "assistant", content: "Let me read.", tool_calls: [call("c" + n + "a", "readDocument"), call("c" + n + "b", "findText", { query: "x" })] },
			{ role: "tool", tool_call_id: "c" + n + "a", content: resultText || "Function executed successfully\n{}" },
			{ role: "tool", tool_call_id: "c" + n + "b", content: "Function executed successfully\n{\"totalMatches\":1}" }
		]
	};
}

test("plain chat without tools keeps old shape", () => {
	const items = [user("hi"), reply("hello"), user("again")];
	assert.deepStrictEqual(H.build(items), [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "hello" },
		{ role: "user", content: "again" }
	]);
});

test("tool transcript is re-inserted between user and final reply", () => {
	const items = [
		user("summarize", nativeTurn(1)),
		reply("Let me read."), // intermediate streamed text, already in transcript
		toolItem("readDocument"), toolItem("findText"),
		reply("Here is the summary."),
		user("now shorter")
	];
	const msgs = H.build(items);
	assertValid(msgs);
	assert.deepStrictEqual(msgs.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant", "user"]);
	assert.strictEqual(msgs[4].content, "Here is the summary.");
	assert.strictEqual(msgs.filter((m) => m.content === "Let me read." && !m.tool_calls).length, 0, "intermediate text not duplicated");
});

test("long tool results and arguments are truncated, args stay valid JSON", () => {
	const big = "x".repeat(H.HISTORY_TOOL_RESULT_MAX_CHARS + 500);
	const t = nativeTurn(1, big);
	t.messages[0].tool_calls[0].function.arguments = JSON.stringify({ code: "y".repeat(5000) });
	const msgs = H.build([user("q", t), reply("done")]);
	assertValid(msgs);
	const tool = msgs.find((m) => m.tool_call_id === "c1a");
	assert.ok(tool.content.length < big.length);
	assert.match(tool.content, /\[truncated 500 chars\]$/);
	const args = msgs[1].tool_calls[0].function.arguments;
	assert.doesNotThrow(() => JSON.parse(args));
	assert.ok(args.length < 5000);
});

test("only the last HISTORY_FULL_TOOL_TURNS turns keep tool detail; older ones collapse", () => {
	const items = [];
	for (let n = 1; n <= 5; n++) {
		items.push(user("q" + n, nativeTurn(n)));
		items.push(toolItem("readDocument"));
		items.push(reply("a" + n));
	}
	items.push(user("last"));
	const msgs = H.build(items);
	assertValid(msgs);
	const withCalls = msgs.filter((m) => m.tool_calls);
	assert.strictEqual(withCalls.length, H.HISTORY_FULL_TOOL_TURNS);
	assert.deepStrictEqual(withCalls.map((m) => m.tool_calls[0].id), ["c3a", "c4a", "c5a"]);
	const first = msgs[1];
	assert.strictEqual(first.role, "assistant");
	assert.match(first.content, /^\[Tools used in this step \(details omitted\): readDocument, findText\]\n\na1$/);
});

test("turns ending in an error are dropped completely (no orphan tool messages)", () => {
	const items = [
		user("ok", nativeTurn(1)), reply("fine"),
		user("broken", nativeTurn(2)), toolItem("readDocument"), reply("", { error: 1 }),
		user("next")
	];
	const msgs = H.build(items);
	assertValid(msgs);
	assert.ok(!msgs.some((m) => m.content === "broken"));
	assert.ok(!msgs.some((m) => m.tool_call_id && m.tool_call_id.startsWith("c2")));
	assert.deepStrictEqual(msgs.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant", "user"]);
});

test("stopped turn: missing tool results are filled in, orphans dropped", () => {
	const transcript = {
		hasFinalReply: false,
		messages: [
			{ role: "tool", tool_call_id: "stray", content: "orphan" },
			{ role: "assistant", content: null, tool_calls: [call("a", "readRange"), call("b", "addChart")] },
			{ role: "tool", tool_call_id: "a", content: "ok" },
			{ role: "tool", tool_call_id: "zzz", content: "unrelated" }
		]
	};
	const msgs = H.build([user("chart", transcript), reply("Operation was interrupted."), user("again")]);
	assertValid(msgs);
	assert.ok(!msgs.some((m) => m.tool_call_id === "stray" || m.tool_call_id === "zzz"));
	assert.strictEqual(msgs.find((m) => m.tool_call_id === "b").content, "No result was recorded for this call.");
	// no final reply recorded -> the UI-only interruption text is not sent
	assert.ok(!msgs.some((m) => m.content === "Operation was interrupted."));
});

test("regenerate (same question re-sent) and leading assistant items stay valid", () => {
	const items = [reply("welcome"), user("q", nativeTurn(1)), reply("a"), user("q", nativeTurn(2)), reply("a2"), user("q")];
	assertValid(H.build(items));
});

test("cleared list gives just the new message", () => {
	assert.deepStrictEqual(H.build([user("x")]), [{ role: "user", content: "x" }]);
});

test("flatten turns tool exchanges into alternating plain text", () => {
	const msgs = H.build([user("q", nativeTurn(1)), reply("answer"), user("next")]);
	const flat = H.flatten(msgs);
	assert.ok(flat.every((m) => !m.tool_calls && m.role !== "tool"));
	for (let i = 1; i < flat.length; i++)
		assert.notStrictEqual(flat[i].role, flat[i - 1].role, "roles alternate");
	assert.match(flat[1].content, /Let me read\.\n\[functionCalling \(readDocument\)\]: \{\}\n\[functionCalling \(findText\)\]: \{"query":"x"\}/);
	assert.match(flat[2].content, /^SYSTEM: Result of readDocument:/);
	assert.match(flat[2].content, /SYSTEM: Result of findText:/);
	// the merged result message and the following assistant answer
	assert.strictEqual(flat[3].content, "answer");
	assert.strictEqual(flat[4].content, "next");
});

test("flatten merges a result with the next user message when there is no reply", () => {
	const t = nativeTurn(1); t.hasFinalReply = false;
	const flat = H.flatten(H.build([user("q", t), user("next")]));
	assert.deepStrictEqual(flat.map((m) => m.role), ["user", "assistant", "user"]);
	assert.match(flat[2].content, /next$/);
});

test("prompt-based transcripts pass through and are summarized when old", () => {
	const pt = {
		hasFinalReply: true,
		messages: [
			{ role: "assistant", content: "[functionCalling (readRange)]: {\"range\":\"A1:B2\"}" },
			{ role: "user", content: "SYSTEM: Function executed successfully\n{}" }
		]
	};
	const recent = H.build([user("q", pt), reply("ok")]);
	assert.deepStrictEqual(recent.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
	assert.strictEqual(H.summarize(pt.messages), "[Tools used in this step (details omitted): readRange]");
	const afterText = [{ role: "assistant", content: "Reading it.\n[functionCalling (readRange)]: {}" }];
	assert.strictEqual(H.summarize(afterText), "[Tools used in this step (details omitted): readRange]");
});

test("compactTranscript drops unknown shapes and extra fields", () => {
	const c = H.compactTranscript([
		null, { role: "system", content: "x" },
		{ role: "assistant", content: "", tool_calls: [{ id: "1", index: 0, function: { name: "a", arguments: "{}" } }, { function: { name: "noid" } }] },
		{ role: "tool", tool_call_id: "1", content: "r", extra: 1 }
	]);
	assert.deepStrictEqual(c, [
		{ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "a", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "1", content: "r" }
	]);
});

test("collectToolNames covers UI items and transcripts", () => {
	const names = H.collectToolNames([user("q", nativeTurn(1)), toolItem("addChart"), reply("x")]);
	assert.deepStrictEqual(names.sort(), ["addChart", "findText", "readDocument"]);
});

test("state survives a JSON round trip (persisted chat state)", () => {
	const items = [user("q", nativeTurn(1)), reply("a"), user("n")];
	const restored = JSON.parse(JSON.stringify(items));
	assert.deepStrictEqual(H.build(restored), H.build(items));
});

test("pruneTranscripts keeps transcripts only for the last N user turns", () => {
	const N = H.HISTORY_STORED_TRANSCRIPT_TURNS;
	assert.ok(N > H.HISTORY_FULL_TOOL_TURNS, "pruning must not touch turns that keep the full exchange");
	const items = [];
	for (let n = 0; n < N + 3; n++)
		items.push(user("q" + n, nativeTurn(n)), toolItem("readDocument"), reply("a" + n));
	items.push(user("plain"), reply("ok"));

	assert.strictEqual(H.pruneTranscripts(items), 4);
	const kept = items.filter((i) => i.role === "user" && !i.isToolCall).map((i) => !!i.agentTranscript);
	// N + 4 user turns: the 4 oldest lost their transcript, the plain last turn never had one.
	assert.deepStrictEqual(kept, [false, false, false, false].concat(Array(N - 1).fill(true), [false]));
	assert.strictEqual(H.pruneTranscripts(items), 0);
	assertValid(H.build(items));

	// The history of recent turns is unchanged by pruning.
	const recent = (msgs) => msgs.slice(msgs.findIndex((m) => m.content === "q" + (N + 2 - H.HISTORY_FULL_TOOL_TURNS)));
	const unpruned = [];
	for (let n = 0; n < N + 3; n++)
		unpruned.push(user("q" + n, nativeTurn(n)), toolItem("readDocument"), reply("a" + n));
	unpruned.push(user("plain"), reply("ok"));
	assert.deepStrictEqual(recent(H.build(items)), recent(H.build(unpruned)));

	// Dropped turns fall back to plain text.
	const built = H.build(items);
	const i0 = built.findIndex((m) => m.content === "q0");
	assert.deepStrictEqual(built[i0 + 1], { role: "assistant", content: "a0" });

	// Explicit count.
	assert.strictEqual(H.pruneTranscripts(items, 1), N - 1);
	assert.strictEqual(H.pruneTranscripts(null), 0);
});
