// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 3: model-supplied tool arguments are parsed as data, never executed
// (scripts/helpers/helperFuncs.js: parseToolArguments, parseFuncCall;
// scripts/engine/promptTools.js and the agent loop for prompt-based calls).

import { describe, test, expect, beforeEach } from "vitest";
import { createToolEnv } from "../lib/plugin.js";
import { createAgent } from "../lib/agent.js";
import { createWordDocument } from "../fakes/word.js";

let env, calls;

// Two recorder tools (and one that fails) instead of the registry, so
// nothing touches a document.
const RECORDER_TOOLS = `
		var __echo = new RegisteredFunction({ name: "echo", description: "d", parameters: { type: "object", properties: {} } });
		__echo.call = async function(p) { __calls.push(p); return { ok: true }; };
		var __read = new RegisteredFunction({ name: "peek", readOnly: true, description: "d", parameters: { type: "object", properties: {} } });
		__read.call = async function() { return null; };
		var __boom = new RegisteredFunction({ name: "boom", description: "d", parameters: { type: "object", properties: {} } });
		__boom.call = async function() { throw new window.AgentState.ToolError("it broke"); };
		HELPERS.word = [__echo, [__read, __boom]];
`;

beforeEach(() => {
	env = createToolEnv("word");
	calls = [];
	env.ctx.__calls = calls;
	env.sandbox.run(RECORDER_TOOLS);
	env.helper = env.sandbox.run("new EditorHelperImpl()");
});

const parse = (s) => env.ctx.parseToolArguments(s);

describe("parseToolArguments", () => {
	test("strict JSON objects", () => {
		expect(parse('{"a": 1, "b": [1, 2], "c": {"d": null}}')).toEqual({ a: 1, b: [1, 2], c: { d: null } });
	});

	test("empty input means no arguments", () => {
		expect(parse(undefined)).toEqual({});
		expect(parse(null)).toEqual({});
		expect(parse("")).toEqual({});
		expect(parse("   ")).toEqual({});
	});

	test("objects pass through (providers that already decoded the arguments)", () => {
		const obj = { a: 1 };
		expect(parse(obj)).toBe(obj);
	});

	test("lenient: raw newlines/tabs inside strings and trailing commas", () => {
		expect(parse('{"text": "line1\nline2\tx", "list": [1,2,],}')).toEqual({ text: "line1\nline2\tx", list: [1, 2] });
		expect(parse('{"text": "a,}"}')).toEqual({ text: "a,}" });
		expect(parse('{"q": "say \\"hi\\",", }')).toEqual({ q: 'say "hi",' });
	});

	test.each([
		["single quotes", "{'a': 1}"],
		["unquoted keys", "{a: 1}"],
		["comments", '{"a": 1 /* x */}'],
		["code", '{"a": (globalThis.pwned = 1)}'],
		["function call", "alert(1)"],
		["trailing expression", '{"a": 1} + (globalThis.pwned = 1)']
	])("rejects %s", (_, input) => {
		expect(() => parse(input)).toThrow();
		expect(env.ctx.pwned).toBeUndefined();
		expect(globalThis.pwned).toBeUndefined();
	});

	test.each([["array", "[1, 2]"], ["number", "42"], ["string", '"x"'], ["null", "null"]])("rejects a JSON %s (arguments must be an object)", (_, input) => {
		expect(() => parse(input)).toThrow(/expected a JSON object/);
	});
});

describe("parseFuncCall (prompt-based tool calls)", () => {
	const p = (s) => env.helper.parseFuncCall(s);

	test("parses name and arguments", () => {
		expect(p('[functionCalling (echo)]: {"a": 1}')).toEqual({ funcName: "echo", args: { a: 1 } });
		expect(p('  [functionCalling(echo)] {"a": 1}')).toEqual({ funcName: "echo", args: { a: 1 } });
		expect(p("[functionCalling (echo)]:")).toEqual({ funcName: "echo", args: {} });
	});

	test("only the first JSON object is used; trailing text is ignored, not evaluated", () => {
		expect(p('[functionCalling (echo)]: {"a": "}"} and then {"b": 2}')).toEqual({ funcName: "echo", args: { a: "}" } });
	});

	test("malformed calls report an error", () => {
		expect(p("call echo please").error).toMatch(/Malformed function call/);
		expect(p("[functionCalling (echo)]: 42").error).toMatch(/must be a JSON object/);
		expect(p('[functionCalling (echo)]: x {"a": 1}').error).toMatch(/Unexpected text/);
		expect(p("[functionCalling (echo)]: {a: 1}").error).toMatch(/not valid JSON/);
		expect(p(undefined).error).toMatch(/Malformed/);
	});
});

describe("EditorHelper", () => {
	test("nested tool arrays in HELPERS are flattened", () => {
		// loadTools (meta tool) is always appended
		expect(env.helper.funcs.map((f) => f.name)).toEqual(["echo", "peek", "boom", "loadTools"]);
	});
});

describe("prompt-based calls (AIPromptTools + the agent loop)", () => {
	// Runs one "[functionCalling (...)]" reply through the real agent loop
	// with the recorder tools above; returns the onToolCallEnd result.
	let agent;
	beforeEach(async () => {
		agent = await createAgent({ editorType: "word", fake: createWordDocument({ body: ["Hello"] }), supportsTools: false });
		agent.ctx.__calls = calls;
		agent.sandbox.run(RECORDER_TOOLS);
		agent.ctx.EditorHelper = agent.sandbox.run("new EditorHelperImpl()");
	});
	async function run(reply) {
		agent.engine.queue.push({ content: reply }, { content: "ok" });
		await agent.send("go");
		const ends = agent.win.sent("onToolCallEnd");
		return ends[ends.length - 1].result;
	}

	test("runs the tool with parsed arguments and wraps the result", async () => {
		const r = await run('[functionCalling (echo)]: {"text": "hi", "n": 2}');
		expect(r).toEqual({ message: 'Function executed successfully\n{"ok":true}' });
		expect(calls).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(calls[0]))).toEqual({ text: "hi", n: 2 });
	});

	test("tools without a result report plain success", async () => {
		expect(await run("[functionCalling (peek)]: {}")).toEqual({ message: "Function executed successfully" });
	});

	test("malicious payloads are rejected and not executed", async () => {
		for (const payload of [
			"[functionCalling (echo)]: {a: (globalThis.pwned = 1)}",
			'[functionCalling (echo)]: {"a": `${globalThis.pwned = 1}`}',
			"[functionCalling (echo)]: {\"a\": 1, \"b\": eval(\"globalThis.pwned = 1\")}"
		]) {
			const r = await run(payload);
			expect(r.error).toMatch(/not valid JSON/);
		}
		expect(agent.ctx.pwned).toBeUndefined();
		expect(globalThis.pwned).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(agent.approvals).toHaveLength(0);
	});

	test("unknown tools list the available ones", async () => {
		const r = await run("[functionCalling (nope)]: {}");
		expect(r.error).toMatch(/Unknown tool "nope"\. Available tools: echo, peek, boom, loadTools/);
	});

	test("tool errors are returned, not thrown", async () => {
		expect(await run("[functionCalling (boom)]: {}")).toEqual({ error: "Error:\nit broke" });
	});

	test("the user can decline; the tool does not run", async () => {
		agent.decide = "deny";
		const r = await run('[functionCalling (echo)]: {"x": 1}');
		expect(r).toEqual({ error: agent.ctx.TOOL_DECLINED_MESSAGE, declined: true });
		expect(agent.approvals.map((a) => [a.functionName, JSON.parse(a.arguments)])).toEqual([["echo", { x: 1 }]]);
		expect(calls).toHaveLength(0);
	});

	test("approval is not asked for calls that cannot run", async () => {
		await run("[functionCalling (nope)]: {}");
		await run("[functionCalling (echo)]: {bad}");
		expect(agent.approvals).toHaveLength(0);
		await run('[functionCalling (echo)]: {"x": 1}');
		expect(agent.approvals).toHaveLength(1);
		expect(calls).toHaveLength(1);
	});
});

describe("AIPromptTools.toToolCalls", () => {
	test("converts a reply into one OpenAI-style tool call", async () => {
		const agent = await createAgent({ editorType: "word", fake: createWordDocument({ body: ["Hello"] }) });
		const PT = agent.ctx.AIPromptTools;
		agent.ctx.EditorHelper = agent.sandbox.run("new EditorHelperImpl()");
		const [call] = PT.toToolCalls('[functionCalling (readDocument)]: {"startIndex": 1}');
		expect(call).toMatchObject({ type: "function", function: { name: "readDocument", arguments: '{"startIndex":1}' }, promptCall: '[functionCalling (readDocument)]: {"startIndex": 1}' });
		expect(call.id).toMatch(/^system_\d+_[a-z0-9]+$/);
		expect(call.argumentsError).toBeUndefined();
		const [bad] = PT.toToolCalls("[functionCalling (readDocument)]: {a: 1}");
		expect(bad.function).toEqual({ name: "readDocument", arguments: "" });
		expect(bad.argumentsError).toMatch(/not valid JSON/);
		expect(PT.isToolCall("[functionCalling (x)]: {}")).toBe(true);
		expect(PT.isToolCall(" [functionCalling (x)]: {}")).toBe(false);
	});
});
