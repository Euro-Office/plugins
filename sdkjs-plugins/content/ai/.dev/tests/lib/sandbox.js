// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Loads the plugin's browser scripts, unmodified, into a Node `vm` context
// that looks enough like the plugin iframe: `window` is the global object,
// top-level `function`/`var` declarations become globals and top-level
// `let`/`const`/`class` are shared between scripts, exactly like <script>
// tags. Timers are forwarded lazily so vitest fake timers apply.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// sdkjs-plugins/content/ai
export const PLUGIN_DIR = path.resolve(here, "../../..");

export function pluginPath(rel) {
	return path.join(PLUGIN_DIR, rel);
}

export function readPluginFile(rel) {
	return fs.readFileSync(pluginPath(rel), "utf8");
}

export function createLocalStorage(initial) {
	const data = new Map(Object.entries(initial || {}));
	return {
		getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
		setItem: (k, v) => data.set(String(k), String(v)),
		removeItem: (k) => data.delete(String(k)),
		clear: () => data.clear(),
		key: (i) => Array.from(data.keys())[i] ?? null,
		get length() { return data.size; },
		_data: data
	};
}

// Console that records instead of printing, so expected tool errors do not
// spam the test output. Set AI_TESTS_VERBOSE=1 to see everything.
function createConsole() {
	const logs = [];
	const verbose = !!process.env.AI_TESTS_VERBOSE;
	const make = (level) => (...args) => {
		logs.push({ level, args });
		if (verbose)
			console[level](...args);
	};
	return { log: make("log"), info: make("info"), warn: make("warn"), error: make("error"), debug: make("debug"), _logs: logs };
}

/**
 * @param {object} [globals] extra globals (Asc, AI, fetch, ...)
 * @returns {{ ctx: object, load: (...rel: string[]) => void, run: (code: string, name?: string) => any, logs: any[] }}
 */
export function createSandbox(globals = {}) {
	const sandboxConsole = createConsole();
	const ctx = {
		console: sandboxConsole,
		setTimeout: (...a) => globalThis.setTimeout(...a),
		clearTimeout: (...a) => globalThis.clearTimeout(...a),
		setInterval: (...a) => globalThis.setInterval(...a),
		clearInterval: (...a) => globalThis.clearInterval(...a),
		queueMicrotask: (...a) => globalThis.queueMicrotask(...a),
		structuredClone: (v) => globalThis.structuredClone(v),
		TextDecoder, TextEncoder, AbortController, URL,
		atob: (s) => globalThis.atob(s),
		btoa: (s) => globalThis.btoa(s),
		navigator: { userAgent: "node-vitest" },
		location: { protocol: "https:", href: "https://example.test/plugin/index.html" },
		localStorage: createLocalStorage(),
		...globals
	};
	ctx.window = ctx;
	ctx.self = ctx;
	vm.createContext(ctx);

	function run(code, filename = "inline.js") {
		return vm.runInContext(code, ctx, { filename });
	}

	function load(...files) {
		for (const rel of files)
			// file:// URLs let v8 coverage attribute the code to the plugin file
			run(readPluginFile(rel), pathToFileURL(pluginPath(rel)).href);
	}

	return { ctx, load, run, logs: sandboxConsole._logs };
}

// Round-trips a value through JSON like postMessage-based plugin calls do.
export function jsonClone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
