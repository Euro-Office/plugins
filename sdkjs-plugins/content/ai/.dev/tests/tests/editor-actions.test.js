// SPDX-License-Identifier: AGPL-3.0-only
//
// The plugin never locks the editor with a "Block" action (full overlay):
// chat agent turns run without any action, one-shot requests and the
// tools' own model calls show the non-blocking "Information" status.
// "GroupActions" (one undo step per write) is not affected.

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createAgent, toolCall } from "../lib/agent.js";
import { createSandbox, PLUGIN_DIR } from "../lib/sandbox.js";
import { createWordDocument } from "../fakes/word.js";
import { createPresentation } from "../fakes/slide.js";
import { createToolEnv } from "../lib/plugin.js";

describe("chat agent turn", () => {
	test("never calls StartAction/EndAction with Block and reports the model first", async () => {
		const fake = createWordDocument({ body: ["Hello world"] });
		const agent = await createAgent({ editorType: "word", fake });
		agent.engine.queue.push(
			{ content: "", tool_calls: [toolCall("c1", "readDocument", {})] },
			{ content: "Done." }
		);
		await agent.send("Read it");

		const actions = [...agent.host.methodCalls("StartAction"), ...agent.host.methodCalls("EndAction")];
		expect(actions.filter((c) => c.args[0] !== "GroupActions")).toEqual([]);

		const names = agent.win.commands.map((c) => c[0]);
		expect(agent.win.sent("onAgentStatus")).toEqual([{ model: "Fake model" }]);
		expect(names.indexOf("onAgentStatus")).toBeLessThan(names.indexOf("onToolCallStart"));
	});
});

describe("one-shot requests", () => {
	function engineSandbox() {
		const calls = [];
		const sb = createSandbox({
			Asc: {
				plugin: { info: {}, tr: (s) => s, attachEditorEvent() {} },
				Prompts: {},
				Editor: { callMethod: async (name, args) => { calls.push([name, ...args]); } }
			}
		});
		sb.load("scripts/engine/providers/base.js", "scripts/engine/providers/provider.js", "scripts/engine/engine.js");
		const req = Object.create(sb.ctx.AI.Request.prototype);
		req.modelUI = { name: "M" };
		return { calls, req };
	}

	test("a blocking request shows Information with the same Start and End", async () => {
		const { calls, req } = engineSandbox();
		req._chatRequest = async () => "reply";
		expect(await req.chatRequest("hi")).toBe("reply");
		expect(calls).toEqual([["StartAction", "Information", "AI (M)"], ["EndAction", "Information", "AI (M)"]]);
	});

	test("a failing request ends the Information action too", async () => {
		const { calls, req } = engineSandbox();
		req._chatRequest = async () => { throw { error: 1, message: "boom" }; };
		let handled = null;
		req.setErrorHandler((e) => { handled = e; });
		await req.chatRequest("hi");
		expect(handled.message).toBe("boom");
		expect(calls).toEqual([["StartAction", "Information", "AI (M)"], ["EndAction", "Information", "AI (M)"]]);
	});

	test("a non-blocking request starts no action", async () => {
		const { calls, req } = engineSandbox();
		req._chatRequest = async () => "reply";
		await req.chatRequest("hi", false);
		expect(calls).toEqual([]);
	});
});

describe("static", () => {
	function walk(dir, out = []) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "vendor")
					walk(full, out);
			} else if (entry.name.endsWith(".js")) {
				out.push(full);
			}
		}
		return out;
	}

	test("no Block action in plugin scripts or helper sources", () => {
		const files = [...walk(path.join(PLUGIN_DIR, "scripts")), ...walk(path.join(PLUGIN_DIR, ".dev/helpers"))];
		expect(files.length).toBeGreaterThan(20);
		const block = /(StartAction|EndAction)"\s*,\s*\[\s*"Block"|ai_on(Start|End)Action"\s*,\s*\{\s*type\s*:\s*"Block"/;
		const hits = files.filter((f) => block.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(PLUGIN_DIR, f));
		expect(hits).toEqual([]);
	});
});

// "GroupActions" lock the whole document (sdkjs startGroupActions:
// CollaborativeEditing.Set_GlobalLock). Model requests release the plugin's
// open groups while they wait (AI.Request._wrapRequest) so the user's typing
// is not dropped, and start them again before the reply is written.
describe("GroupActions and model requests", () => {
	const ENGINE = ["scripts/engine/providers/base.js", "scripts/engine/providers/provider.js", "scripts/engine/engine.js"];

	function openGroups(host) {
		let n = 0;
		for (const c of host.calls) {
			if (c.type !== "method" || c.args[0] !== "GroupActions")
				continue;
			if (c.name === "StartAction")
				n++;
			else if (c.name === "EndAction")
				n--;
		}
		return n;
	}

	function pairs(host, type) {
		const calls = host.calls.filter((c) => c.type === "method" && c.args[0] === type);
		return {
			start: calls.filter((c) => c.name === "StartAction").length,
			end: calls.filter((c) => c.name === "EndAction").length
		};
	}

	// Real AI.Request with the provider call replaced: records how many
	// groups are open while the model works and streams `reply`.
	function realEngine(env, reply, { image = false } = {}) {
		env.sandbox.load(...ENGINE);
		const seen = [];
		env.ctx.AI.ActionType = { Chat: "Chat", ImageGeneration: "ImageGeneration" };
		env.ctx.AI.Request.create = () => {
			const req = Object.create(env.ctx.AI.Request.prototype);
			req.modelUI = { name: "M" };
			req._chatRequest = async (content, streamFunc) => {
				seen.push(openGroups(env.host));
				const chunks = Array.isArray(reply) ? reply : [reply];
				if (streamFunc) {
					for (const c of chunks)
						await streamFunc(c);
				}
				return chunks.join("");
			};
			req._imageGenerationRequest = async () => { seen.push(openGroups(env.host)); return image; };
			return req;
		};
		return seen;
	}

	test("a request inside open groups releases them and restores them for the reply", async () => {
		const env = createToolEnv("word", createWordDocument({ body: ["a"] }));
		const seen = realEngine(env, ["x", "y"]);
		const E = env.ctx.Asc.Editor;
		await E.callMethod("StartAction", ["GroupActions"]);
		await E.callMethod("StartAction", ["GroupActions"]);
		const inChunk = [];
		const req = env.ctx.AI.Request.create();
		await req.chatRequest("hi", false, async () => { inChunk.push(openGroups(env.host)); });
		expect(seen).toEqual([0]);
		expect(inChunk).toEqual([2, 2]);
		expect(E.openGroupActions).toBe(2);
		expect(openGroups(env.host)).toBe(2);
	});

	test("groups are restored when the request fails", async () => {
		const env = createToolEnv("word", createWordDocument({ body: ["a"] }));
		realEngine(env, "");
		const req = env.ctx.AI.Request.create();
		req._chatRequest = async () => { throw { error: 1, message: "boom" }; };
		req.setErrorHandler(() => {});
		await env.ctx.Asc.Editor.callMethod("StartAction", ["GroupActions"]);
		await req.chatRequest("hi", false, async () => {});
		expect(openGroups(env.host)).toBe(1);
	});

	test("rewriteText, run as an agent write, waits for the model with no open group", async () => {
		const fake = createWordDocument({ body: ["Old text"], selection: { paragraph: 1 } });
		const env = createToolEnv("word", fake);
		const seen = realEngine(env, ["New ", "text"]);
		await env.ctx.AIEdits.runTool("rewriteText", false, () => env.call("rewriteText", { prompt: "Rewrite", type: "paragraph" }), {});
		expect(seen).toEqual([0]);
		expect(openGroups(env.host)).toBe(0);
		expect(pairs(env.host, "Information")).toEqual({ start: 1, end: 1 });
		expect(env.host.methodCalls("PasteText").map((c) => c.args[0])).toEqual(["New ", "text"]);
	});

	test("checkSpelling waits for the model with no open group", async () => {
		const fake = createWordDocument({ body: ["Teh text"], selection: { paragraph: 1 } });
		const env = createToolEnv("word", fake);
		const seen = realEngine(env, "The text");
		await env.ctx.AIEdits.runTool("checkSpelling", false, () => env.call("checkSpelling", {}), {});
		expect(seen).toEqual([0]);
		expect(openGroups(env.host)).toBe(0);
		expect(pairs(env.host, "Information")).toEqual({ start: 1, end: 1 });
	});

	function presentationEnv(reply) {
		const env = createToolEnv("slide", createPresentation(), {});
		env.host.methods.GetFontList = () => [{ m_wsFontName: "Arial" }];
		return env;
	}

	const DECK = '{"t":"presentation.start","language":"en"}{"t":"theme.start"}{"t":"theme.fonts","major":"Arial","minor":"Arial"}{"t":"theme.end"}{"t":"presentation.end"}';

	test("generatePresentationWithTheme: no open group during the request, every Start has one End", async () => {
		const env = presentationEnv();
		const seen = realEngine(env, [DECK.slice(0, 50), DECK.slice(50)]);
		await env.ctx.AIEdits.runTool("generatePresentationWithTheme", false, () => env.call("generatePresentationWithTheme", { topic: "Cats" }), {});
		expect(seen).toEqual([0]);
		expect(pairs(env.host, "Information")).toEqual({ start: 1, end: 1 });
		expect(openGroups(env.host)).toBe(0);
	});

	test("generatePresentationWithTheme: the catch path ends Information and GroupActions once", async () => {
		const env = presentationEnv();
		env.ctx.AI.ActionType = { Chat: "Chat" };
		env.ctx.AI.Request = { create: () => ({ modelUI: { name: "M" }, chatRequest: async () => { throw new Error("boom"); } }) };
		await env.call("generatePresentationWithTheme", { topic: "Cats" });
		expect(pairs(env.host, "Information")).toEqual({ start: 1, end: 1 });
		expect(openGroups(env.host)).toBe(0);
	});
});

describe("detectFunctionCallingSupport (code.js)", () => {
	function codeSandbox(chatRequestAgent) {
		const calls = [];
		const sb = createSandbox({
			Asc: { plugin: { info: {}, tr: (s) => s, attachEditorEvent() {} } },
			CustomAssistantManager: function() {}
		});
		sb.load("scripts/code.js");
		sb.ctx.Asc.Editor = { callMethod: async (name, args) => { calls.push([name, ...args]); } };
		sb.ctx.AI = {
			CapabilitiesUI: { Chat: 1, Tools: 2 },
			createProviderInstance: () => ({}),
			UI: { Model: function() {} },
			Request: function() { this._chatRequestAgent = chatRequestAgent; }
		};
		const model = { name: "M", id: "m", capabilities: 1, provider: { name: "p", url: "", key: "" } };
		return { calls, model, run: () => sb.ctx.detectFunctionCallingSupport(model) };
	}

	test("success: one Information Start and End, Tools detected", async () => {
		const s = codeSandbox(async () => ({ tool_calls: [{ function: { name: "get_current_time" } }] }));
		await s.run();
		expect(s.calls).toEqual([["StartAction", "Information", "AI (M)"], ["EndAction", "Information", "AI (M)"]]);
		expect(s.model.capabilities & 2).toBe(2);
	});

	test("error: the finally still ends Information once", async () => {
		const s = codeSandbox(async () => { throw new Error("offline"); });
		await s.run();
		expect(s.calls).toEqual([["StartAction", "Information", "AI (M)"], ["EndAction", "Information", "AI (M)"]]);
		expect(s.model.capabilities & 2).toBe(0);
	});
});

describe("agent turn end", () => {
	const last = (agent) => agent.win.commands[agent.win.commands.length - 1][0];

	test("no model configured: the turn still ends, with the reason in the chat", async () => {
		const agent = await createAgent({ fake: createWordDocument({ body: ["a"] }) });
		agent.ctx.AI.Request.create = () => null;
		await agent.send("Hi");
		expect(agent.win.sent("onChatReply")[0]).toMatch(/^Error: No AI model is selected/);
		expect(last(agent)).toBe("onChatStreamEnd");
	});

	test("an exception in the turn still ends it, with the error in the chat", async () => {
		const agent = await createAgent({ fake: createWordDocument({ body: ["a"] }) });
		agent.engine.queue.push(() => { throw new Error("kaputt"); });
		await agent.send("Hi");
		expect(agent.win.sent("onChatReply")).toEqual(["Error: kaputt"]);
		expect(last(agent)).toBe("onChatStreamEnd");
	});
});
