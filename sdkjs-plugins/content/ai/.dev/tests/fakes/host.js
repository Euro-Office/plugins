// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fake editor host: the two primitives every plugin call goes through,
// `Asc.plugin.callCommand` and `Asc.plugin.executeMethod`. The real
// scripts/engine/library.js builds `Asc.Editor` / `Asc.Library` on top of
// these, so tests exercise the real plumbing.
//
// callCommand is faithful to how the editor runs commands: the function is
// serialized with toString() and evaluated in a *separate* context that only
// has `Api` and a JSON copy of `Asc.scope`. Closures over plugin-side
// variables therefore fail just like in the editor. The return value is
// JSON-cloned; an exception inside the command resolves to `undefined`
// (the editor swallows it) and is recorded in `host.commandErrors`.

import vm from "node:vm";
import { jsonClone } from "../lib/sandbox.js";

/**
 * @param {object} opts
 * @param {"word"|"cell"|"slide"|"pdf"} opts.editorType
 * @param {object} [opts.api]      fake `Api` global (see fakes/word.js etc.)
 * @param {object} [opts.methods]  executeMethod handlers: name -> (args) => value
 * @param {object} [opts.scope]    the plugin-side Asc.scope object (shared)
 */
export function createHost({ editorType, api = {}, methods = {}, scope } = {}) {
	const host = {
		editorType,
		api,
		scope: scope || {},
		calls: [],            // [{ type: "command"|"method", name, args }]
		commandErrors: [],
		globals: {},          // extra editor-side globals for commands (e.g. AscCommon)
		methods: {
			GetVersion: () => "9.0.0",
			StartAction: () => undefined,
			EndAction: () => undefined,
			ResizeWindow: () => undefined,
			...methods
		}
	};

	function runCommand(func) {
		const editorCtx = vm.createContext({
			...host.globals,
			Api: api,
			Asc: { scope: jsonClone(host.scope) || {} },
			console: { log() {}, warn() {}, error() {} }
		});
		try {
			const result = vm.runInContext("(" + func.toString() + ")()", editorCtx, { filename: "callCommand.js" });
			return jsonClone(result);
		} catch (e) {
			host.commandErrors.push(e);
			return undefined;
		}
	}

	host.plugin = {
		info: { editorType: editorType, editorSubType: editorType === "pdf" ? "pdf" : undefined, lang: "en-US" },
		tr: (s) => s,
		callCommand(func, isClose, isCalc, callback) {
			host.calls.push({ type: "command", name: "callCommand", args: [isClose, isCalc] });
			const result = runCommand(func);
			if (typeof callback === "function")
				queueMicrotask(() => callback(result));
		},
		executeMethod(name, args, callback) {
			host.calls.push({ type: "method", name, args: jsonClone(args) });
			const handler = host.methods[name];
			if (!handler)
				throw new Error("fake host: executeMethod(\"" + name + "\") is not implemented");
			Promise.resolve()
				.then(() => handler(...(args || [])))
				.then((value) => typeof callback === "function" && callback(value));
		},
		attachEvent() {},
		attachEditorEvent() {},
		sendToPlugin() {}
	};

	host.methodCalls = (name) => host.calls.filter((c) => c.type === "method" && (!name || c.name === name));
	return host;
}
