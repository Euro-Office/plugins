// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Minimal mocks for aiEdits.js / toolApproval.js / toolPreviews.js tests
// (ported with the tests that came with that feature).
// Minimal browser/editor mock for the AI plugin modules (no real editor).
const vm = require("vm");
const fs = require("fs");
const path = require("path");

// sdkjs-plugins/content/ai
const PLUGIN = path.resolve(__dirname, "../../../..");

function makeStorage() {
	let data = {};
	return {
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => { data[k] = String(v); },
		removeItem: (k) => { delete data[k]; },
		_data: data
	};
}

function createContext(opts) {
	opts = opts || {};
	const log = [];
	const ctx = {
		console: { log() {}, warn() {}, error() {} },
		setTimeout, clearTimeout, Promise, JSON, Object, Array, Math, Date, String, Number, Error,
		localStorage: makeStorage(),
		log: log
	};
	ctx.window = ctx;
	ctx.globalThis = ctx;
	ctx.editorType = opts.editorType || "word";
	ctx.methodHandlers = {};
	ctx.Asc = {
		scope: {},
		plugin: { tr: (s) => s, info: { editorType: ctx.editorType } },
		Editor: {
			getType: () => ctx.editorType,
			callCommand: async (fn) => {
				log.push(["command"]);
				// Commands are serialized into the editor in reality; here they
				// run against the mock Api with a copy of Asc.scope.
				return fn();
			},
			callMethod: async (name, args) => {
				log.push(["method", name, args]);
				let h = ctx.methodHandlers[name];
				return h ? h.apply(null, args || []) : undefined;
			}
		}
	};
	vm.createContext(ctx);
	return ctx;
}

function load(ctx, rel) {
	const file = path.join(PLUGIN, rel);
	vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
}

function run(ctx, code) {
	return vm.runInContext(code, ctx);
}

module.exports = { createContext, load, run };
