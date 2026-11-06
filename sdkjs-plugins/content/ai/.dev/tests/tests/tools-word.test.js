// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 2 (word): document tools against the in-memory Document API fake.

import { describe, test, expect } from "vitest";
import { createToolEnv, expectToolError } from "../lib/plugin.js";
import { createWordDocument, BlockSdt, Paragraph } from "../fakes/word.js";

function word(spec) {
	const fake = createWordDocument(spec);
	const env = createToolEnv("word", fake);
	return { ...env, doc: fake.doc };
}

const SAMPLE = {
	body: [
		{ text: "Quarterly report", style: "Heading 1" },
		"Revenue grew by 12 percent. The deadline is Friday.",
		{ text: "Details", style: "Heading 2" },
		{ table: [["Region", "Revenue"], ["North", "deadline 5"]] },
		{ text: "First item", list: true },
		"Closing words about the Deadline."
	]
};

describe("readDocument", () => {
	test("returns elements with index, type, style and list flags", async () => {
		const { call } = word(SAMPLE);
		const r = await call("readDocument");
		expect(r.totalElements).toBe(6);
		expect(r.hasMore).toBe(false);
		expect(r.elements[0]).toEqual({ index: 1, type: "paragraph", style: "Heading 1", text: "Quarterly report" });
		expect(r.elements[3]).toMatchObject({ index: 4, type: "table", rows: 2 });
		expect(r.elements[4]).toMatchObject({ list: true, text: "First item" });
	});

	test("reads table text row by row, cells separated by |", async () => {
		const { call } = word(SAMPLE);
		const r = await call("readDocument");
		expect(r.elements[3]).toEqual({ index: 4, type: "table", rows: 2, text: "Region | Revenue\nNorth | deadline 5" });
	});

	test("reads the text of block content controls", async () => {
		const fake = createWordDocument({ body: ["Intro"] });
		const sdt = new BlockSdt();
		sdt.AddElement(new Paragraph("Inside one"));
		sdt.AddElement(new Paragraph("Inside two"));
		fake.doc.Push(sdt);
		const r = await createToolEnv("word", fake).call("readDocument");
		expect(r.elements[1]).toEqual({ index: 2, type: "blockLvlSdt", text: "Inside one\nInside two" });
	});

	test("long tables are truncated like other elements", async () => {
		const { call } = word({ body: [{ table: [["a".repeat(40), "b".repeat(40)]] }] });
		const r = await call("readDocument", { maxCharsPerElement: 50 });
		expect(r.elements[0]).toMatchObject({ truncated: true, text: "a".repeat(40) + " | " + "b".repeat(7) + "…" });
	});

	test("pages with startIndex/count and reports hasMore", async () => {
		const { call } = word(SAMPLE);
		const r = await call("readDocument", { startIndex: 2, count: 2 });
		expect(r.elements.map((e) => e.index)).toEqual([2, 3]);
		expect(r.returned).toBe(2);
		expect(r.hasMore).toBe(true);
		const past = await call("readDocument", { startIndex: 50 });
		expect(past).toMatchObject({ returned: 0, hasMore: false, elements: [] });
	});

	test("truncates long elements (minimum 50 characters)", async () => {
		const { call } = word({ body: ["x".repeat(300)] });
		const r = await call("readDocument", { maxCharsPerElement: 10 });
		expect(r.elements[0].truncated).toBe(true);
		expect(r.elements[0].text).toBe("x".repeat(50) + "…");
	});

	test("caps count at 200", async () => {
		const { call } = word({ body: Array.from({ length: 250 }, (_, i) => "p" + i) });
		const r = await call("readDocument", { count: 1000 });
		expect(r.returned).toBe(200);
		expect(r.hasMore).toBe(true);
	});

	test.each([
		[{ startIndex: 0 }, /"startIndex" must be a number >= 1/],
		[{ startIndex: "2" }, /"startIndex"/],
		[{ count: 0 }, /"count" must be a positive number/],
		[{ maxCharsPerElement: -1 }, /"maxCharsPerElement"/]
	])("rejects %j", async (args, msg) => {
		await expectToolError(word(SAMPLE).call("readDocument", args), msg);
	});
});

describe("getSelection", () => {
	test("returns the selected text and paragraph indexes", async () => {
		const { call } = word({ ...SAMPLE, selection: { paragraph: 2, start: 0, end: 27 } });
		const r = await call("getSelection");
		expect(r).toEqual({ hasSelection: true, text: "Revenue grew by 12 percent.", paragraphIndexes: [2] });
	});

	test("multi-paragraph selections list every paragraph", async () => {
		const { call } = word({ ...SAMPLE, selection: [{ paragraph: 1 }, { paragraph: 2 }] });
		const r = await call("getSelection");
		expect(r.paragraphIndexes).toEqual([1, 2]);
		expect(r.text).toContain("Quarterly report");
	});

	test("a selection inside a table reports the table's index", async () => {
		const { call } = word({ ...SAMPLE, selection: { paragraph: 4, row: 1, cell: 1, start: 0, end: 8 } });
		const r = await call("getSelection");
		expect(r).toEqual({ hasSelection: true, text: "deadline", paragraphIndexes: [4] });
	});

	test("the cursor in a table cell reports the table's index, not the position in the cell", async () => {
		// The cell paragraph is the first in its cell (GetPosInParent() === 0),
		// which must not be reported as paragraph 1.
		const { call } = word({ ...SAMPLE, cursor: { paragraph: 4, row: 0, cell: 1 } });
		const r = await call("getSelection");
		expect(r).toEqual({ hasSelection: false, text: "", currentParagraphText: "Revenue", paragraphIndexes: [4] });
	});

	test("a paragraph in a block content control reports the control's index", async () => {
		const fake = createWordDocument({ body: ["Intro", "Middle"] });
		const sdt = new BlockSdt();
		const inner = new Paragraph("Inside");
		sdt.AddElement(new Paragraph("First"));
		sdt.AddElement(inner);
		fake.doc.Push(sdt);
		fake.doc.cursor = inner;
		const r = await createToolEnv("word", fake).call("getSelection");
		expect(r.paragraphIndexes).toEqual([3]);
	});

	test("duplicates are reported once (several paragraphs of one table)", async () => {
		const { call } = word({ ...SAMPLE, selection: [{ paragraph: 3 }, { paragraph: 4, row: 0, cell: 0 }, { paragraph: 4, row: 1, cell: 1 }, { paragraph: 5 }] });
		const r = await call("getSelection");
		expect(r.paragraphIndexes).toEqual([3, 4, 5]);
	});

	test("without a selection returns the paragraph at the cursor", async () => {
		const { call } = word({ ...SAMPLE, cursor: 3 });
		const r = await call("getSelection");
		expect(r).toEqual({ hasSelection: false, text: "", currentParagraphText: "Details", paragraphIndexes: [3] });
	});
});

describe("replaceSelection", () => {
	test("replaces the selection through ReplaceTextSmart (one entry per line)", async () => {
		const { call, doc, host } = word({ ...SAMPLE, selection: { paragraph: 2, start: 0, end: 27 } });
		const r = await call("replaceSelection", { text: "Sales rose 12%." });
		expect(r).toEqual({ replacedCharacters: 27 });
		expect(host.methodCalls("ReplaceTextSmart")[0].args).toEqual([["Sales rose 12%."]]);
		expect(doc.texts()[1]).toBe("Sales rose 12%. The deadline is Friday.");

		// the new text is marked as AI-generated and the selection released
		expect(doc.controls().map((c) => [c.GetTag(), c.GetText(), c.appearance])).toEqual([["ai-generated", "Sales rose 12%.", "hidden"]]);
		expect(doc.controls()[0].GetAlias()).toMatch(/^AI-generated \(unknown model, \d{4}-\d{2}-\d{2}\)$/);
		expect(doc.selection).toBeNull();

		doc.selection = [{ para: doc.elements[1], start: 0, end: 3 }];
		await call("replaceSelection", { text: "a\nb" });
		expect(host.methodCalls("ReplaceTextSmart")[1].args).toEqual([["a", "b"]]);
	});

	test("trackChanges turns revision tracking on for the edit and restores it", async () => {
		const { call, doc } = word({ ...SAMPLE, selection: { paragraph: 2, start: 0, end: 7 } });
		await call("replaceSelection", { text: "Income", trackChanges: true });
		expect(doc.revisions.User).toEqual([expect.objectContaining({ Type: "TextAdd", Value: "Income" })]);
		expect(doc.trackRevisions).toBe(false);
	});

	test("trackChanges leaves tracking on when it was already on", async () => {
		const { call, doc } = word({ ...SAMPLE, selection: { paragraph: 2, start: 0, end: 7 } });
		doc.trackRevisions = true;
		await call("replaceSelection", { text: "Income", trackChanges: true });
		expect(doc.trackRevisions).toBe(true);
	});

	test("requires a selection and a text", async () => {
		await expectToolError(word(SAMPLE).call("replaceSelection", { text: "x" }), /Nothing is selected/);
		await expectToolError(word({ ...SAMPLE, selection: { paragraph: 2 } }).call("replaceSelection", {}), /"text" is required/);
	});
});

describe("editParagraph", () => {
	test("replace keeps the paragraph style and first run formatting; extra lines become paragraphs", async () => {
		const { call, doc } = word({ body: [{ text: "Old", style: "Heading 2", textPr: { bold: true } }, "after"] });
		const r = await call("editParagraph", { index: 1, action: "replace", text: "New title\nSecond line" });
		expect(r).toEqual({ totalElements: 3 });
		expect(doc.texts()).toEqual(["New title", "Second line", "after"]);
		expect(doc.elements[0].style.GetName()).toBe("Heading 2");
		// new text sits in a hidden "ai-generated" inline control, formatting kept
		const sdt = doc.elements[0].runs[0];
		expect(sdt.GetClassType()).toBe("inlineLvlSdt");
		expect([sdt.GetTag(), sdt.appearance]).toEqual(["ai-generated", "hidden"]);
		expect(sdt.runs[0].textPr).toEqual({ bold: true });
		expect(doc.controls().map((c) => c.GetText())).toEqual(["New title", "Second line"]);
		expect(doc.elements[1].style.GetName()).toBe("Heading 2");
	});

	test("insertBefore / insertAfter with a style", async () => {
		const { call, doc } = word({ body: ["one", "two"] });
		await call("editParagraph", { index: 1, action: "insertAfter", text: "Summary", style: "Heading 1" });
		await call("editParagraph", { index: 1, action: "insertBefore", text: "Top" });
		expect(doc.texts()).toEqual(["Top", "one", "Summary", "two"]);
		expect(doc.elements[2].style.GetName()).toBe("Heading 1");
	});

	test("unknown style is a warning, not a failure", async () => {
		const { call, doc } = word({ body: ["one"] });
		const r = await call("editParagraph", { index: 1, action: "insertAfter", text: "x", style: "Fancy" });
		expect(r.warning).toMatch(/Style "Fancy" not found/);
		expect(doc.texts()).toEqual(["one", "x"]);
	});

	test("delete removes the element", async () => {
		const { call, doc } = word(SAMPLE);
		expect(await call("editParagraph", { index: 4, action: "delete" })).toEqual({ totalElements: 5 });
		expect(doc.elements.some((e) => e.GetClassType() === "table")).toBe(false);
	});

	test("refuses to replace a table", async () => {
		await expectToolError(word(SAMPLE).call("editParagraph", { index: 4, action: "replace", text: "x" }), /Element 4 is a table, not a paragraph/);
	});

	test("out-of-range index", async () => {
		const { call, doc } = word(SAMPLE);
		await expectToolError(call("editParagraph", { index: 7, action: "delete" }), /Index 7 is out of range\. The document has 6 elements/);
		expect(doc.elements).toHaveLength(6);
	});

	test.each([
		[{ index: 0, action: "delete" }, /"index" must be a number >= 1/],
		[{ index: "1", action: "delete" }, /"index"/],
		[{ index: 1, action: "rewrite" }, /"action" must be one of/],
		[{ index: 1, action: "replace" }, /"text" is required for action "replace"/],
		[{ index: 1, action: "insertAfter", text: "x", style: 3 }, /"style" must be a string/]
	])("rejects %j", async (args, msg) => {
		await expectToolError(word(SAMPLE).call("editParagraph", args), msg);
	});
});

describe("selectText", () => {
	test("selects the n-th occurrence so replaceSelection can edit it", async () => {
		const { call, doc } = word(SAMPLE);
		const r = await call("selectText", { query: "deadline", occurrence: 3 });
		expect(r).toEqual({ selected: "Deadline", occurrence: 3, index: 6, totalMatches: 3 });
		expect(doc.selectedText()).toBe("Deadline");
		await call("replaceSelection", { text: "due date" });
		expect(doc.texts()[5]).toBe("Closing words about the due date.");
	});

	test("missing occurrences are errors", async () => {
		const { call } = word(SAMPLE);
		await expectToolError(call("selectText", { query: "nothing here" }), /No match for "nothing here"/);
		await expectToolError(call("selectText", { query: "deadline", occurrence: 9 }), /Occurrence 9 does not exist; there are only 3 matches/);
		await expectToolError(call("selectText", { query: "x", occurrence: 0 }), /"occurrence"/);
	});
});

describe("commands run in the editor context", () => {
	test("no tool command throws inside the editor for a typical document", async () => {
		const env = word({ ...SAMPLE, selection: { paragraph: 2, start: 0, end: 7 }, comments: [{ id: "1", text: "c" }] });
		for (const [name, args] of [
			["readDocument", {}], ["getSelection", {}], ["selectText", { query: "Revenue" }]
		])
			await env.call(name, args);
		expect(env.host.commandErrors).toEqual([]);
	});
});
