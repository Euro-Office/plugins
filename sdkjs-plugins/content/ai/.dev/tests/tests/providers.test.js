// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 6: provider adapters (scripts/engine/providers) and the agent request
// path in scripts/engine/engine.js (_chatRequestAgent), with `fetch` stubbed.

import { describe, test, expect, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { createSandbox, readPluginFile, pluginPath } from "../lib/sandbox.js";

const TOOLS = [
	{ name: "readDocument", description: "Read", parameters: { type: "object", properties: { startIndex: { type: "number", description: "s" } } }, examples: [], returns: {} },
	{ name: "replaceSelection", description: "Replace", parameters: { type: "object", properties: { text: { type: "string", description: "t" } }, required: ["text"] }, examples: [], returns: {} }
];

function sse(events) {
	return events.map((e) => (e.event ? "event: " + e.event + "\n" : "") + "data: " + (typeof e.data === "string" ? e.data : JSON.stringify(e.data)) + "\n\n").join("");
}

// Response whose body arrives in the given string chunks (split anywhere).
function streamResponse(chunks) {
	const enc = new TextEncoder();
	return new Response(new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		}
	}), { status: 200 });
}

function splitEvery(text, n) {
	const out = [];
	for (let i = 0; i < text.length; i += n) out.push(text.substring(i, i + n));
	return out;
}

let sb, fetches, responder;

function loadProvider(file) {
	// Same wrapper as AI.loadInternalProviders (base.js).
	const rel = "scripts/engine/providers/internal/" + file + ".js";
	return sb.run("(function(){\n" + readPluginFile(rel) + "\nreturn new Provider();})();", pathToFileURL(pluginPath(rel)).href);
}

beforeEach(() => {
	fetches = [];
	responder = null;
	sb = createSandbox({
		Asc: { plugin: { info: {}, tr: (s) => s, attachEditorEvent() {} }, Prompts: {} },
		fetch: async (url, init) => {
			fetches.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
			return responder(url, init);
		},
		Response, ReadableStream
	});
	sb.load("scripts/engine/providers/base.js", "scripts/engine/providers/provider.js", "scripts/engine/engine.js");
	sb.ctx.AgentState = { isStopped: false };
});

// Calls the real _chatRequestAgent for a provider instance.
async function agentRequest(provider, modelId, content, streamFunc) {
	sb.ctx.AI.Storage = { getProvider: () => provider };
	const req = { modelUI: { name: modelId, provider: provider.name, id: modelId }, model: { id: modelId, name: modelId } };
	return await sb.ctx.AI.Request.prototype._chatRequestAgent.call(req, content, streamFunc);
}

describe("OpenAI-compatible base provider", () => {
	test("maps tools to the OpenAI function format", () => {
		const p = loadProvider("openai");
		const body = p.getChatCompletions({ messages: [{ role: "user", content: "hi" }] }, { id: "gpt-4o" });
		p.addTools(body, TOOLS);
		expect(body).toEqual({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{ type: "function", function: { name: "readDocument", description: "Read", parameters: TOOLS[0].parameters } },
				{ type: "function", function: { name: "replaceSelection", description: "Replace", parameters: TOOLS[1].parameters } }
			]
		});
		const none = {};
		p.addTools(none, []);
		expect(none).toEqual({});
	});

	test("parses content and tool calls from responses", () => {
		const p = loadProvider("openai");
		const msg = { data: { choices: [{ message: { content: "\nHello\n", tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] } }] } };
		expect(p.getChatCompletionsResult(msg, {}).content).toEqual(["Hello"]);
		expect(p.getToolCallsResult(msg)).toEqual([{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }]);
		expect(p.getToolCallsResult({ data: { choices: [{ message: { content: "x" } }] } })).toBeNull();
		expect(p.getToolCallsResult({ data: {} })).toBeNull();
	});

	test("tools capability comes from the model UI flags", () => {
		const p = loadProvider("openai");
		const caps = sb.ctx.AI.CapabilitiesUI;
		expect(p.isSupportTools({}, { capabilities: caps.Chat | caps.Tools })).toBe(true);
		expect(p.isSupportTools({}, { capabilities: caps.Chat })).toBe(false);
		expect(p.isSupportTools({}, undefined)).toBe(false);
	});
});

describe("Anthropic provider", () => {
	const history = [
		{ role: "system", content: "SYS" },
		{ role: "user", content: "Fix it" },
		{ role: "assistant", content: "Let me look.", tool_calls: [
			{ id: "t1", type: "function", function: { name: "readDocument", arguments: "{\"startIndex\":1}" } },
			{ id: "t2", type: "function", function: { name: "replaceSelection", arguments: "not json" } }
		] },
		{ role: "tool", tool_call_id: "t1", content: "Function executed successfully\n{}" },
		{ role: "tool", tool_call_id: "t2", content: "" },
		{ role: "user", content: "SYSTEM: more" },
		{ role: "assistant", content: null, tool_calls: [{ id: "t3", type: "function", function: { name: "readDocument", arguments: {} } }] },
		{ role: "tool", tool_call_id: "t3", content: "ok" }
	];

	test("converts the OpenAI-style history to Messages API blocks", () => {
		const p = loadProvider("anthropic");
		const body = p.getChatCompletions({ messages: JSON.parse(JSON.stringify(history)) }, { id: "claude-sonnet-4-5" });
		expect(body.system).toBe("SYS");
		expect(body.messages).toEqual([
			{ role: "user", content: "Fix it" },
			{ role: "assistant", content: [
				{ type: "text", text: "Let me look." },
				{ type: "tool_use", id: "t1", name: "readDocument", input: { startIndex: 1 } },
				{ type: "tool_use", id: "t2", name: "replaceSelection", input: {} }
			] },
			// consecutive user-role messages (tool results + text) are merged
			{ role: "user", content: [
				{ type: "tool_result", tool_use_id: "t1", content: "Function executed successfully\n{}" },
				{ type: "tool_result", tool_use_id: "t2", content: "" },
				{ type: "text", text: "SYSTEM: more" }
			] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t3", name: "readDocument", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "ok" }] }
		]);
	});

	test("maps tools to input_schema and reads tool_use blocks", () => {
		const p = loadProvider("anthropic");
		const body = {};
		p.addTools(body, TOOLS);
		expect(body.tools).toEqual([
			{ name: "readDocument", description: "Read", input_schema: TOOLS[0].parameters },
			{ name: "replaceSelection", description: "Replace", input_schema: TOOLS[1].parameters }
		]);
		const resp = { data: { content: [{ type: "text", text: "Sure" }, { type: "tool_use", id: "tu1", name: "replaceSelection", input: { text: "x" } }] } };
		expect(p.getToolCallsResult(resp)).toEqual([{ id: "tu1", type: "function", function: { name: "replaceSelection", arguments: "{\"text\":\"x\"}" } }]);
		expect(p.getChatCompletionsResult(resp, {}).content).toEqual(["Sure"]);
		expect(p.getToolCallsResult({ data: { content: [{ type: "text", text: "no tools" }] } })).toBeNull();
	});

	test("sends the API key header, not a bearer token", () => {
		const p = loadProvider("anthropic");
		p.key = "sk-ant";
		const h = p.getRequestHeaderOptions();
		expect(h["x-api-key"]).toBe("sk-ant");
		expect(h.Authorization).toBeUndefined();
		expect(h["anthropic-version"]).toBeTruthy();
	});
});

describe("engine: agent requests", () => {
	test("OpenAI streaming: content and tool-call deltas are accumulated across split chunks", async () => {
		const p = loadProvider("openai");
		p.key = "sk-test";
		const events = [
			{ data: { choices: [{ delta: { role: "assistant", content: "" } }] } },
			{ data: { choices: [{ delta: { content: "Checking" } }] } },
			{ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "readDocument", arguments: "" } }] } }] } },
			{ data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"start" } }] } }] } },
			{ data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "Index\": 2}" } }] } }] } },
			{ data: { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "getSelection", arguments: "{}" } }] } }] } },
			{ data: { choices: [{ delta: {}, finish_reason: "tool_calls" }] } },
			{ data: "[DONE]" }
		];
		responder = () => streamResponse(splitEvery(sse(events), 7));
		const chunks = [];
		const res = await agentRequest(p, "gpt-4o", { messages: [{ role: "user", content: "hi" }], tools: TOOLS }, async (c) => chunks.push(c));

		expect(fetches[0].url).toBe("https://api.openai.com/v1/chat/completions");
		expect(fetches[0].init.headers.Authorization).toBe("Bearer sk-test");
		expect(fetches[0].body.stream).toBe(true);
		expect(fetches[0].body.tools.map((t) => t.function.name)).toEqual(["readDocument", "replaceSelection"]);
		expect(res.content).toBe("Checking");
		expect(chunks.join("")).toBe("Checking");
		expect(res.tool_calls).toEqual([
			{ index: 0, id: "call_1", type: "function", function: { name: "readDocument", arguments: "{\"startIndex\": 2}" } },
			{ index: 1, id: "call_2", type: "function", function: { name: "getSelection", arguments: "{}" } }
		]);
	});

	test("prompt-based calls are buffered, not streamed into the chat", async () => {
		const p = loadProvider("openai");
		const text = "[functionCalling (readDocument)]: {\"startIndex\": 1}";
		const events = splitEvery(text, 5).map((t) => ({ data: { choices: [{ delta: { content: t } }] } }));
		responder = () => streamResponse([sse(events)]);
		const chunks = [];
		const res = await agentRequest(p, "gpt-4o", { messages: [{ role: "user", content: "hi" }] }, async (c) => chunks.push(c));
		expect(res.content).toBe(text);
		expect(chunks).toEqual([]);
	});

	test("Anthropic streaming: tool_use blocks are assembled from input_json_delta events", async () => {
		const p = loadProvider("anthropic");
		const events = [
			{ event: "message_start", data: { type: "message_start", message: { id: "m", content: [] } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "On it." } } },
			{ event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "replaceSelection", input: {} } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"te" } } },
			{ event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "xt\": \"Hi}\"}" } } },
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
			{ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" } } },
			{ event: "message_stop", data: { type: "message_stop" } }
		];
		responder = () => streamResponse(splitEvery(sse(events), 11));
		const chunks = [];
		const res = await agentRequest(p, "claude-sonnet-4-5", { messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }], tools: TOOLS }, async (c) => chunks.push(c));

		expect(fetches[0].url).toBe("https://api.anthropic.com/v1/messages");
		expect(fetches[0].body.system).toBe("SYS");
		expect(fetches[0].body.tools[1].input_schema).toEqual(TOOLS[1].parameters);
		expect(res.content).toBe("On it.");
		expect(res.tool_calls).toEqual([{ index: 1, id: "toolu_1", type: "function", function: { name: "replaceSelection", arguments: "{\"text\": \"Hi}\"}" } }]);
	});

	test("the agent's message history is not modified by the provider (system prompt survives the loop)", async () => {
		const p = loadProvider("anthropic");
		responder = () => streamResponse([sse([{ data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } }])]);
		const content = { messages: [{ role: "system", content: "SYS + document context" }, { role: "user", content: "hi" }], tools: TOOLS };
		await agentRequest(p, "claude-sonnet-4-5", content, async () => {});
		expect(content.messages.map((m) => m.role)).toEqual(["system", "user"]);
		await agentRequest(p, "claude-sonnet-4-5", content, async () => {});
		expect(fetches[1].body.system).toBe("SYS + document context");
	});

	test("non-streaming responses return content and tool calls", async () => {
		const p = loadProvider("openai");
		responder = () => new Response(JSON.stringify({ choices: [{ message: { content: "Hi", tool_calls: [{ id: "a", type: "function", function: { name: "readDocument", arguments: "{}" } }] } }] }));
		const res = await agentRequest(p, "gpt-4o", { messages: [{ role: "user", content: "hi" }], tools: TOOLS });
		expect(fetches[0].body.stream).toBeUndefined();
		expect(res.content).toBe("Hi");
		expect(res.tool_calls[0].function.name).toBe("readDocument");
	});

	test("provider errors are thrown as { error, message }", async () => {
		const p = loadProvider("openai");
		responder = () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });
		await expect(agentRequest(p, "gpt-4o", { messages: [] })).rejects.toMatchObject({ error: 1, message: "Invalid API key" });

		responder = () => streamResponse([sse([{ data: { error: { message: "Overloaded" } } }])]);
		await expect(agentRequest(p, "gpt-4o", { messages: [] }, async () => {})).rejects.toMatchObject({ message: "Overloaded" });
	});

	test("stop aborts the stream", async () => {
		const p = loadProvider("openai");
		const events = [{ data: { choices: [{ delta: { content: "a" } }] } }, { data: { choices: [{ delta: { content: "b" } }] } }];
		responder = () => streamResponse([sse(events.slice(0, 1)), sse(events.slice(1))]);
		const chunks = [];
		const res = await agentRequest(p, "gpt-4o", { messages: [] }, async (c) => { chunks.push(c); sb.ctx.AgentState.isStopped = true; });
		expect(chunks).toEqual(["a"]);
		expect(res.content).toBe("a");
	});
});
