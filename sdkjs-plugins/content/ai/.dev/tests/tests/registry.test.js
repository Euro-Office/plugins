// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 1: contract of the tool registry (scripts/helpers/helpers.js, generated
// from .dev/helpers by helpers.py) for every editor.

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Ajv from "ajv";
import { createToolEnv } from "../lib/plugin.js";
import { PLUGIN_DIR, readPluginFile } from "../lib/sandbox.js";

const EDITORS = ["word", "cell", "slide"];

const enTr = JSON.parse(readPluginFile("translations/helpers/en.json"));
const deTr = JSON.parse(readPluginFile("translations/helpers/de-DE.json"));

function loadRegistry(editor) {
	const env = createToolEnv(editor);
	return { env, helper: env.helper, HELPERS: env.ctx.HELPERS };
}

describe.each(EDITORS)("tool registry: %s", (editor) => {
	const { helper, HELPERS } = loadRegistry(editor);
	const funcs = helper.funcs;
	const names = funcs.map((f) => f.name);

	test("tool names are unique and valid function names", () => {
		expect(new Set(names).size).toBe(names.length);
		for (const name of names)
			expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
	});

	test.each(funcs.map((f) => [f.name, f]))("%s has a description, label and translations", (name, func) => {
		expect(func.description.length).toBeGreaterThan(20);
		// labels come from the "text" field in .dev/helpers (loadTools is built in)
		const label = helper.names2text[name];
		expect(label, "missing \"text\" label in .dev/helpers").toBeTruthy();
		if (name !== "loadTools")
			expect(HELPERS.names[editor][name]).toBe(label);
		expect(helper.getHumanName(name)).toBe(label);
		expect(enTr[label], "translations/helpers/en.json is missing \"" + label + "\"").toBe(label);
		expect(deTr[label], "translations/helpers/de-DE.json is missing \"" + label + "\"").toBeTruthy();
	});

	test.each(funcs.map((f) => [f.name, f]))("%s has a valid JSON Schema and valid examples", (name, func) => {
		const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
		const schema = func.parameters;
		expect(schema.type).toBe("object");
		expect(ajv.validateSchema(schema), ajv.errorsText(ajv.errors)).toBe(true);
		const validate = ajv.compile(schema);
		const props = schema.properties || {};
		for (const req of schema.required || [])
			expect(Object.keys(props), "required \"" + req + "\" is not a property").toContain(req);
		for (const [prop, def] of Object.entries(props)) {
			expect(def.description, name + "." + prop + " has no description").toBeTruthy();
			expect(def.type || def.enum || def.anyOf || def.oneOf, name + "." + prop + " has no type").toBeTruthy();
		}
		expect(Array.isArray(func.examples)).toBe(true);
		for (const ex of func.examples) {
			expect(typeof ex.prompt).toBe("string");
			expect(validate(ex.arguments), name + " example " + JSON.stringify(ex.arguments) + ": " + ajv.errorsText(validate.errors)).toBe(true);
		}
	});

	test("getTools() returns clean provider tool definitions", () => {
		const tools = helper.getTools();
		expect(tools.map((t) => t.name)).toEqual(names);
		for (const t of tools) {
			expect(Object.keys(t).sort()).toEqual(["description", "examples", "name", "parameters", "returns"]);
			expect(t).not.toHaveProperty("readOnly");
			expect(t).not.toHaveProperty("call");
			expect(t).not.toHaveProperty("text");
		}
		// a deep copy: mutating it must not touch the registry
		tools[0].parameters.injected = true;
		expect(funcs[0].parameters.injected).toBeUndefined();
	});

	test("every tool has an implementation", () => {
		for (const f of funcs)
			expect(typeof f.call, f.name).toBe("function");
	});

});

describe("tool registry: other editors", () => {
	test("pdf has no tools", () => {
		const { helper } = loadRegistry("pdf");
		expect(helper.funcs).toEqual([]);
		expect(helper.getTools()).toBeNull();
		expect(helper.getToolsSystemPrompt()).toBe("");
	});
});

describe("translations", () => {
	test("every helper label has an English and German entry, and nothing is stale", () => {
		const labels = new Set();
		for (const editor of EDITORS) {
			const { helper } = loadRegistry(editor);
			Object.values(helper.names2text).forEach((l) => labels.add(l));
		}
		const enKeys = Object.keys(enTr);
		expect(enKeys.filter((k) => !labels.has(k)), "stale keys in en.json").toEqual([]);
		expect([...labels].filter((l) => !(l in deTr)), "missing in de-DE.json").toEqual([]);
	});
});

describe("generated helpers.js", () => {
	const python = ["python3", "python"].find((p) => {
		try { execFileSync(p, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
	});

	// Locally the check is skipped without Python; in CI it must run.
	test.skipIf(!python && !process.env.CI)("is in sync with .dev/helpers (run `cd .dev/helpers && python3 helpers.py`)", () => {
		expect(python, "python3 is needed to check scripts/helpers/helpers.js").toBeTruthy();
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-helpers-"));
		try {
			fs.cpSync(path.join(PLUGIN_DIR, ".dev/helpers"), path.join(tmp, ".dev/helpers"), { recursive: true });
			fs.mkdirSync(path.join(tmp, "scripts/helpers"), { recursive: true });
			execFileSync(python, ["helpers.py"], { cwd: path.join(tmp, ".dev/helpers") });
			const generated = fs.readFileSync(path.join(tmp, "scripts/helpers/helpers.js"), "utf8");
			const committed = readPluginFile("scripts/helpers/helpers.js");
			expect(generated === committed, "scripts/helpers/helpers.js is out of date; regenerate it").toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
