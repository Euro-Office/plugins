// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Tool categories and loadTools (scripts/helpers/toolCategories.js, helperFuncs.js)
// (ported from the standalone node:test suite that came with the feature).

import { test } from "vitest";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { PLUGIN_DIR as AI_DIR } from "../lib/sandbox.js";
import { createToolEnv } from "../lib/plugin.js";


// The real scripts on the fake editor host; EditorHelper as in the plugin.
function loadEditor(editorType) {
	const env = createToolEnv(editorType);
	env.ctx.EditorHelper = env.helper;
	return env.ctx;
}

const KNOWN = ["core", "edit-text", "format", "comments-review", "structure", "data", "analysis",
	"charts-visuals", "conditional-formatting", "generate", "notes", "macro"];

// plain host arrays, so deepStrictEqual does not trip over vm prototypes
function names(tools) { return Array.from(tools, (t) => t.name); }
const plain = (v) => JSON.parse(JSON.stringify(v));

test("every tool source declares a known category", () => {
	for (const ed of ["word", "cell", "slide"]) {
		const dir = path.join(AI_DIR, ".dev/helpers", ed);
		for (const f of fs.readdirSync(dir)) {
			const src = fs.readFileSync(path.join(dir, f), "utf8");
			const m = src.match(/"category"\s*:\s*"([^"]+)"/);
			assert.ok(m, ed + "/" + f + " has no category");
			assert.ok(KNOWN.includes(m[1]), ed + "/" + f + ": unknown category " + m[1]);
		}
	}
});

test("getTools strips internal fields and keeps the old full list without categories", () => {
	const c = loadEditor("cell");
	const all = c.EditorHelper.getTools();
	assert.ok(all.length > 20);
	assert.ok(!names(all).includes("loadTools"));
	for (const t of all) {
		assert.deepStrictEqual(plain(Object.keys(t).sort()), ["description", "examples", "name", "parameters", "returns"]);
	}
});

test("core + macro + loadTools are always sent", () => {
	for (const ed of ["word", "cell", "slide"]) {
		const h = loadEditor(ed).EditorHelper;
		const cats = h.selectCategories({ text: "Explain the history of Rome in detail please" });
		assert.ok(cats.includes("core") && cats.includes("macro"), ed);
		const n = names(h.getTools(cats));
		assert.ok(n.includes("writeMacro") && n.includes("loadTools"), ed);
	}
});

test("keyword inference (English and German)", () => {
	const h = loadEditor("cell").EditorHelper;
	const pick = (t) => h.selectCategories({ text: t });
	assert.ok(pick("Create a bar chart of the sales per region").includes("charts-visuals"));
	assert.ok(pick("Erstelle ein Diagramm der Umsätze pro Region").includes("charts-visuals"));
	assert.ok(pick("Sortiere die Tabelle nach Datum absteigend").includes("data"));
	assert.ok(pick("Add a color scale to column C please").includes("conditional-formatting"));
	assert.ok(pick("Füge eine bedingte Formatierung für Werte über 100 hinzu").includes("conditional-formatting"));
	assert.ok(pick("Why does the formula in D5 return an error?").includes("analysis"));
	const notGuessed = pick("Make the header row bold and blue");
	assert.ok(notGuessed.includes("format"));
	assert.ok(!notGuessed.includes("conditional-formatting"));
	assert.ok(!notGuessed.includes("charts-visuals"));

	const w = loadEditor("word").EditorHelper;
	assert.ok(w.selectCategories({ text: "Kommentiere die Einleitung mit Verbesserungsvorschlägen" }).includes("comments-review"));
	assert.ok(w.selectCategories({ text: "Mach die Überschrift fett" }).includes("format"));
});

test("categories are limited to what the editor has", () => {
	const s = loadEditor("slide").EditorHelper;
	const cats = s.selectCategories({ text: "Add conditional formatting and sort the data" });
	assert.ok(!cats.includes("conditional-formatting"));
	assert.ok(!cats.includes("data"));
});

test("short or unmatched messages fall back to the editor default set", () => {
	const h = loadEditor("word").EditorHelper;
	for (const t of ["", "hi", "do it", "Please help me with this thing"]) {
		const cats = h.selectCategories({ text: t });
		for (const c of ["core", "edit-text", "format", "macro"])
			assert.ok(cats.includes(c), JSON.stringify(t) + " missing " + c);
	}
});

test("selection context and earlier tools add categories", () => {
	const h = loadEditor("cell").EditorHelper;
	const ctx = { editor: "cell", selection: "A1:D20", selectionRows: 20, selectionColumns: 4, formulasInPreview: 3 };
	const cats = h.selectCategories({ text: "Explain the history of these numbers in detail", context: ctx });
	assert.ok(cats.includes("data") && cats.includes("analysis"));
	const used = h.selectCategories({ text: "Make another one for the costs but in green", usedTools: ["addChart", "unknownTool"] });
	assert.ok(used.includes("charts-visuals"));
});

test("loadTools adds tools for the following iterations of the turn", async () => {
	const h = loadEditor("cell").EditorHelper;
	const session = h.createToolSession({ text: "Read the values in the first sheet and tell me about them" });
	assert.ok(!session.categories.includes("conditional-formatting"));
	assert.ok(!names(session.getTools()).includes("addColorScale"));
	assert.strictEqual(h.isReadOnly("loadTools"), true);

	const res = await h.names2funcs.loadTools.call({ categories: ["conditional-formatting"] });
	assert.deepStrictEqual(plain(res.loaded), ["conditional-formatting"]);
	assert.ok(res.newlyAvailableTools.includes("addColorScale"));
	assert.strictEqual(session.consumeChanged(), true);
	assert.strictEqual(session.consumeChanged(), false);
	assert.ok(names(session.getTools()).includes("addColorScale"));

	// loading an already loaded category changes nothing
	await h.names2funcs.loadTools.call({ categories: ["core"] });
	assert.strictEqual(session.consumeChanged(), false);

	await assert.rejects(h.names2funcs.loadTools.call({ categories: ["bogus"] }), /Unknown categories: bogus/);
	await assert.rejects(h.names2funcs.loadTools.call({}), /non-empty array/);
});

test("loadTools description lists every category of the editor once", () => {
	for (const ed of ["word", "cell", "slide"]) {
		const h = loadEditor(ed).EditorHelper;
		const desc = h.names2funcs.loadTools.description;
		for (const c of h.getAvailableCategories())
			assert.ok(desc.includes("\n- " + c + ": "), ed + " " + c);
		assert.deepStrictEqual(plain(h.names2funcs.loadTools.parameters.properties.categories.items.enum), plain(h.getAvailableCategories()));
	}
});

test("prompt-based system prompt follows the selection and is cached per set", () => {
	const h = loadEditor("cell").EditorHelper;
	const small = h.getSystemPrompt(["core", "macro"]);
	const big = h.getSystemPrompt(["core", "macro", "conditional-formatting"]);
	assert.ok(small.includes("- readRange\n") && small.includes("- loadTools\n"));
	assert.ok(!small.includes("- addColorScale\n"));
	assert.ok(big.includes("- addColorScale\n"));
	assert.strictEqual(h.getSystemPrompt(["core", "macro"]), small);
	assert.ok(small.length < h.getSystemPrompt().length);
	assert.ok(small.includes("eo://cell/"));
});

test("tools payload is smaller for typical prompts", () => {
	const prompts = {
		word: ["Summarize this document", "Make the second heading bold", "Kommentiere den Abschnitt über Kosten", "Rewrite this paragraph to sound more formal"],
		cell: ["Create a chart of sales by month", "Sortiere nach Spalte B", "Highlight values above average", "What is the total revenue?"],
		slide: ["Add a slide about our roadmap", "Schreibe Sprechernotizen für alle Folien", "Change the background of slide 2 to dark blue", "Fix typos on this slide"]
	};
	const wire = (tools) => JSON.stringify(tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })));
	const rows = [];
	for (const ed of Object.keys(prompts)) {
		const h = loadEditor(ed).EditorHelper;
		const all = h.getTools();
		for (const p of prompts[ed]) {
			const sel = h.getTools(h.selectCategories({ text: p }));
			assert.ok(Buffer.byteLength(wire(sel)) < Buffer.byteLength(wire(all)), ed + ": " + p);
			rows.push([ed, p, all.length + "→" + sel.length, Buffer.byteLength(wire(all)) + "→" + Buffer.byteLength(wire(sel))]);
		}
	}
	if (process.env.REPORT)
		console.log(rows.map((r) => r.join(" | ")).join("\n"));
});

test("tools system prompts mention loadTools and the editor's citation format", () => {
	const expect = { word: ["eo://word/paragraph/", "eo://word/find?text="], cell: ["eo://cell/"], slide: ["eo://slide/"] };
	for (const ed of Object.keys(expect)) {
		const h = loadEditor(ed).EditorHelper;
		for (const p of [h.getToolsSystemPrompt(), h.getSystemPrompt(h.selectCategories({ text: "hi" }))]) {
			assert.ok(p.includes("loadTools"), ed);
			for (const s of expect[ed]) assert.ok(p.includes(s), ed + " " + s);
			for (const other of Object.keys(expect).filter((e) => e !== ed))
				assert.ok(!p.includes("eo://" + other + "/"), ed + " mentions " + other);
		}
	}
});
