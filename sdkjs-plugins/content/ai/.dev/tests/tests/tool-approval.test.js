// SPDX-License-Identifier: AGPL-3.0-only
//
// Editor-initiated tool calls and approvals (scripts/engine/toolApproval.js)
// (ported from the mock tests that came with the feature).

import { test } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../fakes/aiedits/mocks.cjs");


function setup(respond, canOpen) {
	const ctx = M.baseContext("word");
	const doc = M.wordApi(ctx);
	const stack = M.undoStack(ctx, true);
	ctx.calls = [];
	M.addTool(ctx, "word", { name: "readThing", readOnly: true }, async (a) => { ctx.calls.push(["readThing", a]); return { text: "hi" }; });
	M.addTool(ctx, "word", { name: "writeThing" }, async (a) => { ctx.calls.push(["writeThing", a]); doc.write(1, a.text || "x"); return { ok: true }; });
	M.addTool(ctx, "word", { name: "writeMacro" }, async (a) => { ctx.calls.push(["writeMacro", a]); return 42; });
	M.addTool(ctx, "word", { name: "boom" }, async () => { throw new ctx.AgentState.ToolError("kaputt"); });
	M.installChatWindowShow(ctx, respond, canOpen);
	return { ctx, doc, stack };
}


	test("readOnly tool runs directly without opening the chat", async () => {
		const { ctx, stack } = setup(() => "deny");
		const res = await ctx.ToolApproval.handleEditorToolCall({ name: "readThing", arguments: "{\"q\":1}" });
		assert.deepStrictEqual(ctx.calls, [["readThing", { q: 1 }]]);
		assert.strictEqual(res.text, "hi");
		assert.match(res.message, /executed successfully/);
		assert.strictEqual(ctx.chatWindowShowCalls, 0);
		assert.strictEqual(stack.groups, 0, "read-only tools are not grouped");
	});

	test("writing tool opens the chat, asks, runs after Allow (grouped, tracked)", async () => {
		let asked = null;
		const { ctx, doc, stack } = setup((data) => { asked = data; return "allow"; });
		const res = await ctx.ToolApproval.handleEditorToolCall({ name: "writeThing", arguments: { text: "neu" } });
		assert.strictEqual(ctx.chatWindowShowCalls, 1);
		assert.ok(asked, "approval requested");
		assert.strictEqual(asked.functionName, "writeThing");
		assert.strictEqual(asked.source, "editor");
		assert.deepStrictEqual(ctx.calls, [["writeThing", { text: "neu" }]]);
		assert.strictEqual(res.ok, true);
		assert.strictEqual(stack.groups, 1);
		assert.strictEqual(stack.depth, 1);
		assert.strictEqual(doc.track, false, "track changes restored");
		assert.strictEqual(doc.user, "User", "author restored");
		assert.strictEqual(doc.revisions.length, 1);
		assert.strictEqual(doc.revisions[0].author, "AI");
		const names = ctx.chatWindow.commands.map((c) => c[0]);
		assert.deepStrictEqual(names, ["onToolCallStart", "onToolApprovalRequest", "onToolCallEnd"]);
	});

	test("Deny returns a declined error result and does not run the tool", async () => {
		const { ctx, stack } = setup(() => "deny");
		const res = await ctx.ToolApproval.handleEditorToolCall({ name: "writeThing", arguments: "{}" });
		assert.strictEqual(res.declined, true);
		assert.match(res.error, /declined/);
		assert.deepStrictEqual(ctx.calls, []);
		assert.strictEqual(stack.groups, 0);
	});

	test("unknown tool -> error result, no throw, no window", async () => {
		const { ctx } = setup(() => "allow");
		const res = await ctx.ToolApproval.handleEditorToolCall({ name: "nope", arguments: "{}" });
		assert.match(res.error, /Unknown tool "nope"/);
		assert.strictEqual(ctx.chatWindowShowCalls, 0);
		const res2 = await ctx.ToolApproval.handleEditorToolCall(null);
		assert.match(res2.error, /Unknown tool/);
		const res3 = await ctx.ToolApproval.handleEditorToolCall({ name: "constructor" });
		assert.match(res3.error, /Unknown tool/, "prototype keys are not tools");
	});

	test("invalid JSON arguments -> error result, tool not run", async () => {
		const { ctx } = setup(() => "allow");
		const res = await ctx.ToolApproval.handleEditorToolCall({ name: "readThing", arguments: "{\"a\": alert(1)}" });
		assert.match(res.error, /not valid JSON/);
		assert.deepStrictEqual(ctx.calls, []);
		const res2 = await ctx.ToolApproval.handleEditorToolCall({ name: "readThing", arguments: "[1,2]" });
		assert.match(res2.error, /not valid JSON/);
	});

	test("chat window cannot be opened -> error result, tool not run", async () => {
		const { ctx } = setup(() => "allow", false);
		const res = await ctx.ToolApproval.handleEditorToolCall({ name: "writeThing", arguments: "{}" });
		assert.strictEqual(res.declined, true);
		assert.match(res.error, /could not be opened/);
		assert.deepStrictEqual(ctx.calls, []);
	});

	test("tool error -> error result; group ended and tracking restored", async () => {
		const { ctx, doc, stack } = setup(() => "allow");
		const res = await ctx.ToolApproval.handleEditorToolCall({ name: "boom", arguments: "{}" });
		assert.match(res.error, /kaputt/);
		assert.strictEqual(stack.groups, 1);
		assert.strictEqual(stack.depth, 1, "EndAction GroupActions sent");
		assert.strictEqual(doc.track, false);
		assert.strictEqual(doc.user, "User");
	});

	test("Always allow is remembered (localStorage); writeMacro only for the window session", async () => {
		let asked = 0;
		const { ctx } = setup(() => { asked++; return "always"; });
		await ctx.ToolApproval.handleEditorToolCall({ name: "writeThing", arguments: "{}" });
		await ctx.ToolApproval.handleEditorToolCall({ name: "writeThing", arguments: "{}" });
		assert.strictEqual(asked, 1);
		const stored = JSON.parse(ctx.localStorage.getItem("onlyoffice_ai_tool_always_allow"));
		assert.strictEqual(stored.writeThing, true);

		const r = await ctx.ToolApproval.handleEditorToolCall({ name: "writeMacro", arguments: { code: "1" } });
		assert.strictEqual(r.result, 42, "primitive results are wrapped");
		await ctx.ToolApproval.handleEditorToolCall({ name: "writeMacro", arguments: { code: "1" } });
		assert.strictEqual(asked, 2);
		assert.strictEqual(stored.writeMacro, undefined);
		assert.ok(!JSON.parse(ctx.localStorage.getItem("onlyoffice_ai_tool_always_allow")).writeMacro);

		// closing the chat ends the session permission
		ctx.ToolApproval.unbindWindow(ctx.chatWindow);
		delete ctx.chatWindow;
		await ctx.ToolApproval.handleEditorToolCall({ name: "writeMacro", arguments: { code: "1" } });
		assert.strictEqual(asked, 3);
	});

	test("approval card carries the macro code and stays pending until answered; stop denies", async () => {
		const { ctx } = setup(null); // never answers
		const p = ctx.ToolApproval.handleEditorToolCall({ name: "writeMacro", arguments: { code: "Api.GetDocument()" } });
		await new Promise((r) => setTimeout(r, 30));
		const req = ctx.chatWindow.commands.find((c) => c[0] === "onToolApprovalRequest")[1];
		assert.strictEqual(req.code, "Api.GetDocument()");
		assert.ok(ctx.ToolApproval.hasPending());
		ctx.ToolApproval.denyAll(); // "Stop" in the chat / chat closed
		const res = await p;
		assert.strictEqual(res.declined, true);
		assert.deepStrictEqual(ctx.calls, []);
	});

	test("chat agent approvals: stopped agent denies, editor requests are unaffected", async () => {
		const { ctx } = setup(null);
		ctx.chatWindowShow();
		await new Promise((r) => setTimeout(r, 10));
		const chatReq = ctx.ToolApproval.request({ toolCallId: "c1", functionName: "writeThing", args: {}, source: "chat" });
		const edReq = ctx.ToolApproval.request({ toolCallId: "e1", functionName: "writeThing", args: {}, source: "editor" });
		await new Promise((r) => setTimeout(r, 10));
		const reqs = ctx.chatWindow.commands.filter((c) => c[0] === "onToolApprovalRequest").map((c) => c[1]);
		ctx.ToolApproval.respond({ id: reqs[0].id, decision: "allow" }, true);
		ctx.ToolApproval.respond({ id: reqs[1].id, decision: "allow" }, true);
		assert.strictEqual(await chatReq, false);
		assert.strictEqual(await edReq, true);
	});

