// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 3: model-supplied tool arguments are parsed as data, never executed
// (scripts/helpers/helperFuncs.js: parseToolArguments, parseFuncCall, callFunc).

import { describe, test, expect, beforeEach } from "vitest";
import { createToolEnv } from "../lib/plugin.js";

let env, calls;

beforeEach(() => {
	env = createToolEnv("word");
	calls = [];
	env.ctx.__calls = calls;
	// Replace the registry with two recorder tools so nothing touches a document.
	env.sandbox.run(`
		var __echo = new RegisteredFunction({ name: "echo", description: "d", parameters: { type: "object", properties: {} } });
		__echo.call = async function(p) { __calls.push(p); return { ok: true }; };
		var __read = new RegisteredFunction({ name: "peek", readOnly: true, description: "d", parameters: { type: "object", properties: {} } });
		__read.call = async function() { return null; };
		var __boom = new RegisteredFunction({ name: "boom", description: "d", parameters: { type: "object", properties: {} } });
		__boom.call = async function() { throw new window.AgentState.ToolError("it broke"); };
		HELPERS.word = [__echo, [__read, __boom]];
	`);
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

describe("callFunc", () => {
	test("runs the tool with parsed arguments and wraps the result", async () => {
		const r = await env.helper.callFunc('[functionCalling (echo)]: {"text": "hi", "n": 2}');
		expect(r).toEqual({ message: 'Function executed successfully\n{"ok":true}' });
		expect(calls).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(calls[0]))).toEqual({ text: "hi", n: 2 });
	});

	test("tools without a result report plain success", async () => {
		expect(await env.helper.callFunc("[functionCalling (peek)]: {}")).toEqual({ message: "Function executed successfully" });
	});

	test("nested tool arrays in HELPERS are flattened", () => {
		// loadTools (meta tool) is always appended
		expect(env.helper.funcs.map((f) => f.name)).toEqual(["echo", "peek", "boom", "loadTools"]);
	});

	test("malicious payloads are rejected and not executed", async () => {
		for (const payload of [
			"[functionCalling (echo)]: {a: (globalThis.pwned = 1)}",
			'[functionCalling (echo)]: {"a": `${globalThis.pwned = 1}`}',
			"[functionCalling (echo)]: {\"a\": 1, \"b\": eval(\"globalThis.pwned = 1\")}"
		]) {
			const r = await env.helper.callFunc(payload);
			expect(r.error).toMatch(/not valid JSON/);
		}
		expect(env.ctx.pwned).toBeUndefined();
		expect(globalThis.pwned).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("unknown tools list the available ones", async () => {
		const r = await env.helper.callFunc("[functionCalling (nope)]: {}");
		expect(r.error).toMatch(/Unknown tool "nope"\. Available tools: echo, peek, boom, loadTools/);
	});

	test("tool errors are returned, not thrown", async () => {
		const r = await env.helper.callFunc("[functionCalling (boom)]: {}");
		expect(r).toEqual({ error: "Error:\nit broke" });
	});

	test("beforeCall hook can decline; the tool does not run", async () => {
		const seen = [];
		const r = await env.helper.callFunc('[functionCalling (echo)]: {"x": 1}', {
			beforeCall: async (name, args) => { seen.push([name, JSON.parse(JSON.stringify(args))]); return false; }
		});
		expect(r).toEqual({ error: env.ctx.TOOL_DECLINED_MESSAGE, declined: true });
		expect(seen).toEqual([["echo", { x: 1 }]]);
		expect(calls).toHaveLength(0);
	});

	test("beforeCall is not consulted for calls that cannot run", async () => {
		let asked = 0;
		const hooks = { beforeCall: async () => { asked++; return true; } };
		await env.helper.callFunc("[functionCalling (nope)]: {}", hooks);
		await env.helper.callFunc("[functionCalling (echo)]: {bad}", hooks);
		expect(asked).toBe(0);
		await env.helper.callFunc('[functionCalling (echo)]: {"x": 1}', hooks);
		expect(asked).toBe(1);
		expect(calls).toHaveLength(1);
	});
});
