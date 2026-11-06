// SPDX-License-Identifier: AGPL-3.0-only
//
// Static checks: every plugin script parses, every JSON file is valid and
// config.json references files that exist. (CI runs `node --check` too.)

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PLUGIN_DIR } from "../lib/sandbox.js";

function walk(dir, ext, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || full === path.join(PLUGIN_DIR, ".dev/tests"))
				continue;
			walk(full, ext, out);
		} else if (entry.name.endsWith(ext)) {
			out.push(full);
		}
	}
	return out;
}

const rel = (f) => path.relative(PLUGIN_DIR, f);

describe("syntax", () => {
	const scripts = walk(PLUGIN_DIR, ".js").filter((f) => !rel(f).startsWith("vendor/"));
	test.each(scripts.map((f) => [rel(f), f]))("%s parses", (_, file) => {
		expect(() => new vm.Script(fs.readFileSync(file, "utf8"), { filename: file })).not.toThrow();
	});
});

describe("JSON", () => {
	const files = walk(PLUGIN_DIR, ".json").filter((f) => !rel(f).startsWith("vendor/"));
	test.each(files.map((f) => [rel(f), f]))("%s is valid JSON", (_, file) => {
		expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
	});

	test("config.json points at existing pages and the plugin GUID", () => {
		const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "config.json"), "utf8"));
		expect(config.guid).toBe("asc.{9DC93CDB-B576-4F0C-B55E-FCC9C48DD007}");
		for (const v of config.variations)
			expect(fs.existsSync(path.join(PLUGIN_DIR, v.url)), v.url).toBe(true);
	});

	test("index.html and the chat sidebar only load files that exist", () => {
		for (const page of ["index.html", "sidebar/index.html"]) {
			const html = fs.readFileSync(path.join(PLUGIN_DIR, page), "utf8");
			for (const [, src] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
				if (/^https?:/.test(src)) continue;
				expect(fs.existsSync(path.join(PLUGIN_DIR, path.dirname(page), src)), page + " -> " + src).toBe(true);
			}
		}
	});

	test("the chat sidebar opens as a docked right panel", () => {
		const js = fs.readFileSync(path.join(PLUGIN_DIR, "scripts/engine/chatWindow.js"), "utf8");
		expect(js).toMatch(/url\s*:\s*"sidebar\/index\.html"/);
		expect(js).toMatch(/type\s*:\s*"panelRight"/);
		expect(js).not.toMatch(/localStorage\.(getItem|setItem)\("onlyoffice_ai_chat_placement"/);
	});

	test("every internal provider listed in providers/config.json exists", () => {
		const list = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "scripts/engine/providers/config.json"), "utf8"));
		for (const name of list)
			expect(fs.existsSync(path.join(PLUGIN_DIR, "scripts/engine/providers/internal", name + ".js")), name).toBe(true);
	});
});
