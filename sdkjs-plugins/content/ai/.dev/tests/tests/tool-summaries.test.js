// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Plain-language sentences for the chat's tool cards: the describe()
// templates next to the tools, the generic fallback, error sentences,
// translations and the fields on the tool call events (UI only).

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createToolEnv } from "../lib/plugin.js";
import { createAgent, toolCall } from "../lib/agent.js";
import { createWordDocument } from "../fakes/word.js";

const PLUGIN_DIR = path.resolve(__dirname, "../../..");
const deTr = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "translations/de-DE.json"), "utf8"));

function helperFor(editor, tr) {
	const env = createToolEnv(editor);
	if (tr)
		env.host.plugin.tr = tr;
	return env.helper;
}

describe("describe() templates", () => {
	const word = helperFor("word");
	const cell = helperFor("cell");

	test("readDocument: requested window, then what was read", () => {
		expect(word.describeToolCall("readDocument", { startIndex: 51, count: 50 })).toEqual({ summary: "Read paragraphs 51 to 100", groupPhrase: "read the document" });
		expect(word.describeToolCall("readDocument", {}, { result: { totalElements: 12, returned: 12, hasMore: false } }).resultSummary).toBe("Read the whole document (12 paragraphs)");
		expect(word.describeToolCall("readDocument", { startIndex: 51 }, { result: { totalElements: 300, returned: 50, hasMore: true } }).resultSummary).toBe("Read paragraphs 51 to 100 of 300");
	});

	test("findText: matches counted, long queries truncated to 60 characters", () => {
		const outcome = (n) => ({ result: { totalMatches: n } });
		expect(word.describeToolCall("findText", { query: "budget" }, outcome(3)).resultSummary).toBe("Searched for “budget” (3 matches)");
		expect(word.describeToolCall("findText", { query: "budget" }, outcome(1)).resultSummary).toBe("Searched for “budget” (1 match)");
		expect(word.describeToolCall("findText", { query: "budget" }, outcome(0)).resultSummary).toBe("Searched for “budget” (no matches)");
		const long = word.describeToolCall("findText", { query: "x".repeat(100) + "\n\nsecret" }).summary;
		expect(long).toBe("Search for “" + "x".repeat(59) + "…”");
	});

	test("edits: editParagraph, replaceSelection, insertMarkdown, writeRange, writeMacro", () => {
		expect(word.describeToolCall("editParagraph", { index: 3, action: "insertAfter", text: "Intro", style: "Heading 1" }, { result: {} }))
			.toEqual({ summary: "Insert a heading after paragraph 3", groupPhrase: "edited the document", resultSummary: "Inserted a heading after paragraph 3" });
		expect(word.describeToolCall("replaceSelection", { text: "Hi" }, { result: {} }).resultSummary).toBe("Replaced the selected text");
		expect(word.describeToolCall("insertMarkdown", { markdown: "# A", position: "end" }).summary).toBe("Add text at the end of the document");
		expect(cell.describeToolCall("writeRange", { startCell: "A1", values: [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]] }, { result: { sheet: "Sheet1", range: "A1:C4", cellsWritten: 12 } }))
			.toEqual({ summary: "Write 12 cells to A1", groupPhrase: "wrote cells", resultSummary: "Wrote 12 cells to Sheet1!A1:C4" });
		const macro = word.describeToolCall("writeMacro", { code: "Api.GetDocument().RemoveAllElements()" }, { result: 1 });
		expect(macro).toEqual({ summary: "Run a macro", groupPhrase: "ran a macro", resultSummary: "Ran a macro" });
	});

	test("fallback: tool name and up to three short values, long values skipped", () => {
		expect(cell.describeToolCall("setNumberFormat", { range: "D2:D100", sheet: "Sales", format: "0.0%" }))
			.toEqual({ summary: "Set Number Format · D2:D100 · Sales · 0.0%", groupPhrase: "used “Set Number Format”" });
		expect(cell.describeToolCall("setNumberFormat", { range: "D2:D100", format: "x".repeat(200) }).summary).toBe("Set Number Format · D2:D100");
		expect(cell.describeToolCall("setNumberFormat", { range: "A".repeat(45) }).summary).toBe("Set Number Format · " + "A".repeat(29) + "…");
		expect(word.describeToolCall("noSuchTool", {}).summary).toBe("noSuchTool");
	});

	test("errors in plain words", () => {
		expect(cell.describeToolCall("readRange", { range: "A1", sheet: "Q3" }, { error: "Sheet \"Q3\" not found." }).resultSummary).toBe("Couldn't find sheet “Q3”");
		expect(word.describeToolCall("replaceSelection", { text: "x" }, { error: "Nothing is selected. Ask the user to select text" }).resultSummary).toBe("Couldn't do this: nothing is selected");
		expect(word.describeToolCall("readOutline", {}, { error: "Parameter \"maxLevel\" must be a number" }).resultSummary).toBe("Couldn't do this: Read the outline");
		expect(word.describeToolCall("replaceSelection", { text: "x" }, { error: "The user declined this action.", declined: true }).resultSummary).toBe("You declined: Replace the selected text");
	});

	test("a throwing describe() falls back instead of breaking the call", () => {
		word.names2funcs.readOutline.describe = () => { throw new Error("boom"); };
		expect(word.describeToolCall("readOutline", { maxLevel: 2 }).summary).toBe("Read Outline · 2");
	});

	test("placeholders are filled in one pass: a value containing %1 stays literal", () => {
		expect(cell.describeToolCall("writeRange", { startCell: "A1", values: [[1, 2]] }, { result: { sheet: "S%1", range: "A1", cellsWritten: 2 } }).resultSummary)
			.toBe("Wrote 2 cells to S%1!A1");
		expect(word.describeToolCall("findText", { query: "50%2 off" }, { result: { totalMatches: 3 } }).resultSummary).toBe("Searched for “50%2 off” (3 matches)");
	});

	test("unknown tool names from the model are capped at 60 characters", () => {
		const name = "x".repeat(200);
		const res = word.describeToolCall(name, {});
		expect(res.summary).toBe("x".repeat(59) + "…");
		expect(res.groupPhrase).toBe("used “" + "x".repeat(59) + "…”");
	});

	test("readRange without sheet/address in the result falls back to the start sentence", () => {
		expect(cell.describeToolCall("readRange", { range: "A1:B2" }, { result: {} }).resultSummary).toBe("Read cells A1:B2");
		expect(cell.describeToolCall("readRange", {}, { result: { address: "C3" } }).resultSummary).toBe("Read cells C3");
	});

	test("non-string start/done/phrase from describe() are ignored", () => {
		word.names2funcs.readOutline.describe = () => ({ start: { html: "<b>x</b>" }, done: 42, phrase: ["a"] });
		expect(word.describeToolCall("readOutline", { maxLevel: 2 }, { result: {} })).toEqual({ summary: "Read Outline · 2", groupPhrase: "used “Read Outline”", resultSummary: "Read Outline · 2" });
	});

	test("describe() is never sent to providers", () => {
		for (const helper of [word, cell, helperFor("slide")]) {
			expect(helper.funcs.filter((f) => f.describe).length).toBeGreaterThan(5);
			expect(JSON.stringify(helper.getTools())).not.toContain("describe");
		}
	});
});

describe("translations", () => {
	test("German through Asc.plugin.tr, with placeholders", () => {
		const cell = helperFor("cell", (s) => deTr[s] || s);
		expect(cell.describeToolCall("findInSheet", { query: "Budget" }, { result: { totalMatches: 2 } }))
			.toEqual({ summary: "Nach „Budget“ suchen", groupPhrase: "gesucht", resultSummary: "Nach „Budget“ gesucht (2 Treffer)" });
		expect(cell.describeToolCall("writeRange", { startCell: "A1", values: [[1]] }, { result: { sheet: "S", range: "A1", cellsWritten: 1 } }).resultSummary).toBe("1 Zellen in S!A1 geschrieben");
		expect(cell.describeToolCall("readRange", {}, { error: "Sheet \"Q3\" not found." }).resultSummary).toBe("Tabellenblatt „Q3“ nicht gefunden");
	});

	test("every template in the tool sources and helperFuncs.js has a German translation", () => {
		const files = ["word", "cell", "slide"].flatMap((d) => fs.readdirSync(path.join(PLUGIN_DIR, ".dev/helpers", d)).map((f) => path.join(PLUGIN_DIR, ".dev/helpers", d, f)));
		files.push(path.join(PLUGIN_DIR, "scripts/helpers/helperFuncs.js"));
		const templates = new Set();
		for (const file of files) {
			for (const m of fs.readFileSync(file, "utf8").matchAll(/toolText\("([^"]+)"/g))
				templates.add(m[1]);
		}
		expect(templates.size).toBeGreaterThan(80);
		expect([...templates].filter((t) => !deTr[t])).toEqual([]);
		// placeholders survive translation
		expect([...templates].filter((t) => (t.match(/%\d/g) || []).sort().join() !== (deTr[t].match(/%\d/g) || []).sort().join())).toEqual([]);
	});
});

describe("events", () => {
	test("start, end and approval events carry the sentences; the model never sees them", async () => {
		const fake = createWordDocument({ body: ["Budget plan", "Other"], selection: { paragraph: 1, start: 0, end: 6 } });
		const agent = await createAgent({ editorType: "word", fake });
		agent.engine.queue.push(
			{ content: "", tool_calls: [toolCall("c1", "findText", { query: "Budget" }), toolCall("c2", "replaceSelection", { text: "Plan" })] },
			{ content: "Done." }
		);
		await agent.send("Go");
		expect(agent.win.sent("onToolCallStart").map((e) => [e.summary, e.groupPhrase])).toEqual([
			["Search for “Budget”", "searched"],
			["Replace the selected text", "replaced the selected text"]
		]);
		expect(agent.win.sent("onToolCallEnd").map((e) => e.resultSummary)).toEqual(["Searched for “Budget” (1 match)", "Replaced the selected text"]);
		expect(agent.approvals.map((a) => a.summary)).toEqual(["Replace the selected text"]);
		const sentToModel = JSON.stringify(agent.engine.requests);
		expect(sentToModel).not.toContain("Searched for");
		expect(sentToModel).not.toContain("groupPhrase");
	});
});
