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
