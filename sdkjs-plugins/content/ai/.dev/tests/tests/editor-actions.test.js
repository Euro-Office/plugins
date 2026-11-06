// SPDX-License-Identifier: AGPL-3.0-only
//
// The plugin never locks the editor with a "Block" action (full overlay):
// one-shot requests and the tools' own model calls show the non-blocking
// "Information" status.
// "GroupActions" (one undo step per write) is not affected.

import { describe, test, expect } from "vitest";
import { createSandbox } from "../lib/sandbox.js";

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
