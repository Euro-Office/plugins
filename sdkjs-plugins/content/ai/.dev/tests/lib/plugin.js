// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Ready-made environments that load the shipped plugin scripts on top of a
// fake editor host (see fakes/host.js).

import { expect } from "vitest";
import { createSandbox } from "./sandbox.js";
import { createHost } from "../fakes/host.js";

// The scripts the background plugin loads for tools (index.html order).
export const TOOL_SCRIPTS = [
	"vendor/md/markdown-it.js",
	"scripts/engine/library.js",
	"scripts/helpers/aiProvenance.js",
	"scripts/engine/aiEdits.js",
	"scripts/helpers/helperFuncs.js",
	"scripts/helpers/helpers.js",
	"scripts/helpers/toolCategories.js",
	"scripts/helpers/agentHistory.js",
	"scripts/helpers/citations.js",
	"scripts/helpers/toolPreviews.js"
];

/**
 * Plugin context with library.js + helpers loaded for one editor.
 * @param {"word"|"cell"|"slide"|"pdf"} editorType
 * @param {{ Api?: object, methods?: object }} [fake] from fakes/word.js, cell.js or slide.js
 * @param {object} [globals] extra globals for the sandbox
 */
export function createToolEnv(editorType, fake = {}, globals = {}) {
	const host = createHost({ editorType, api: fake.Api, methods: fake.methods });
	const sandbox = createSandbox({
		Asc: { plugin: host.plugin, scope: host.scope },
		AI: {},
		...globals
	});
	sandbox.load(...TOOL_SCRIPTS);
	// chatWindow.js defines AgentState.ToolError when the chat opens; tools need it.
	sandbox.run(`
		window.AgentState = window.AgentState || { isStopped: false };
		window.AgentState.ToolError = class ToolError extends Error {
			constructor(message) { super(message); this.name = "ToolError"; }
		};
	`);
	const helper = sandbox.run("new EditorHelperImpl()");

	async function call(name, args = {}) {
		const func = helper.names2funcs[name];
		if (!func)
			throw new Error("No tool \"" + name + "\" for editor " + editorType);
		return await func.call(args);
	}

	return { sandbox, ctx: sandbox.ctx, host, helper, call, fake };
}

// Asserts the promise rejects with the plugin's ToolError and a matching message.
export async function expectToolError(promise, message) {
	let error;
	try {
		await promise;
	} catch (e) {
		error = e;
	}
	expect(error, "expected a ToolError").toBeDefined();
	expect(error.name).toBe("ToolError");
	if (message !== undefined)
		expect(error.message).toMatch(message);
	return error;
}
