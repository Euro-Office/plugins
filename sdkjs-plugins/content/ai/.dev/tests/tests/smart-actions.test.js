// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 5: SmartActions ranking (scripts/helpers/smartActions.js) and the
// selection suggestion chips loop (scripts/engine/selectionSuggestions.js).

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createSandbox } from "../lib/sandbox.js";
import { createToolEnv } from "../lib/plugin.js";
import { createWordDocument } from "../fakes/word.js";
import { createWorkbook } from "../fakes/cell.js";

const SA = (() => {
	const sb = createSandbox();
	sb.load("scripts/helpers/smartActions.js");
	return sb.ctx.SmartActions;
})();

const ids = (list) => list.map((a) => a.id);
const word = (text) => ({ editor: "word", hasSelection: text.length > 0, selectionText: text });
const slide = (text) => ({ editor: "slide", hasSelection: text.length > 0, selectionText: text });
const cell = (rows, cols, preview, formulas) => ({ editor: "cell", activeSheet: "S", selection: "B2:D10", selectionRows: rows, selectionColumns: cols, preview, formulasInPreview: formulas || 0 });

describe("SmartActions", () => {
	test("without a context: every action of the editor (context menu)", () => {
		expect(SA.get("word").length).toBeGreaterThanOrEqual(6);
		expect(SA.get("pdf")).toEqual([]);
		for (const editor of ["word", "cell", "slide"]) {
			const all = SA.get(editor);
			expect(all).toEqual(SA.all(editor));
			expect(new Set(ids(all)).size).toBe(all.length);
			expect(all.every((a) => a.id && a.text && a.prompt)).toBe(true);
		}
	});

	test("prompts only reference tools that exist", () => {
		const env = { word: createToolEnv("word"), cell: createToolEnv("cell"), slide: createToolEnv("slide") };
		const known = /\b(readDocument|getSelection|replaceSelection|editParagraph|readRange|writeRange|readPresentation|insertMarkdown|findText)\b/g;
		for (const editor of Object.keys(env)) {
			for (const a of SA.all(editor)) {
				for (const m of a.prompt.match(known) || [])
					expect(env[editor].helper.names2funcs[m], editor + "/" + a.id + " mentions " + m).toBeTruthy();
			}
		}
	});

	test("no or empty selection -> no chips", () => {
		expect(SA.get("word", null)).toEqual([]);
		expect(SA.get("word", word(""))).toEqual([]);
		expect(SA.get("word", word("   "))).toEqual([]);
		expect(SA.get("cell", cell(0, 0, ""))).toEqual([]);
	});

	test.each([
		["short text", "Hello world", ["improve", "continue"]],
		["medium text", "x".repeat(200), ["improve", "continue", "shorten"]],
		["long text", "word ".repeat(100), ["summarize", "shorten", "actionItems", "improve"]],
		["tab separated text", "a\tb\nc\td", ["toTable", "summarize", "improve"]]
	])("word: %s", (_, text, expected) => {
		expect(ids(SA.get("word", word(text)))).toEqual(expected);
	});

	test.each([
		["single formula cell", cell(1, 1, "42 {=SUM(A1:A3)}", 1), ["explainFormula"]],
		["single text cell", cell(1, 1, "  hello "), ["cleanUp"]],
		["single number", cell(1, 1, "42"), []],
		["numeric table", cell(6, 3, "Month\tSales\tCost\nJan\t100\t50\nFeb\t120\t60\nMar\t90\t40\nApr\t300\t45\nMay\t1.234,5\t55"), ["chart", "insights", "anomalies", "explainData"]],
		["formulas first, capped", cell(5, 3, "Month\tSales\tTotal\nJan\t100\t100 {=B2}\nFeb\t120\t220 {=C2+B3}\nMar\t90\t310 {=C3+B4}\nApr\t300\t610 {=C4+B5}", 4), ["explainFormula", "chart", "insights", "anomalies"]],
		["text with gaps", cell(4, 2, "Name\tCity\nanna\tberlin\nBob\t\n carl \tMUNICH"), ["cleanUp", "fillMissing", "explainData"]],
		["formula preview from the real editor format", cell(3, 2, "a\t1\nb\t2 {= A1+1}\nc\t3", 1), ["explainFormula", "chart", "insights", "explainData"]]
	])("cell: %s", (_, ctx, expected) => {
		const r = SA.get("cell", ctx);
		expect(ids(r)).toEqual(expected);
		expect(r.length).toBeLessThanOrEqual(SA.MAX_CHIPS);
	});

	test("slide: short and long text", () => {
		expect(ids(SA.get("slide", slide("Title")))).toEqual(["improve", "concise", "summarizeSlide"]);
		expect(ids(SA.get("slide", slide("y".repeat(500))))).toEqual(["concise", "improve", "summarizeSlide"]);
	});

	test("selectionKey changes with the selection", () => {
		expect(SA.selectionKey(word(""))).toBe("");
		expect(SA.selectionKey(word("abc"))).not.toBe(SA.selectionKey(word("abd")));
		expect(SA.selectionKey(word("abc"))).toBe(SA.selectionKey(word(" abc ")));
		const a = cell(2, 2, "1\t2\n3\t4");
		expect(SA.selectionKey(a)).not.toBe(SA.selectionKey({ ...a, selection: "C3:D4" }));
		expect(SA.selectionKey(a)).not.toBe(SA.selectionKey({ ...a, preview: "1\t2\n3\t5" }));
	});

	test("byId returns copies", () => {
		expect(SA.byId("cell", "chart").text).toBe("Create chart");
		expect(SA.byId("cell", "nope")).toBeNull();
		SA.get("word")[0].text = "mutated";
		SA.byId("word", "improve").prompt = "mutated";
		expect(SA.get("word")[0].text).not.toBe("mutated");
		expect(SA.byId("word", "improve").prompt).not.toBe("mutated");
	});

	test("hash is stable 32-bit hex", () => {
		expect(SA.hash("")).toBe("0");
		expect(SA.hash("abc")).toBe(SA.hash("abc"));
		expect(SA.hash("x".repeat(10000))).toMatch(/^-?[0-9a-f]{1,8}$/);
	});
});

// ── selection suggestion chips ─────────────────────────────────────────────

function suggestionsEnv(editorType, fake) {
	const env = createToolEnv(editorType, fake);
	const editorEvents = {};
	env.host.plugin.attachEditorEvent = (name, f) => { editorEvents[name] = f; };
	env.sandbox.load("scripts/helpers/documentContext.js", "scripts/helpers/smartActions.js", "scripts/engine/selectionSuggestions.js");
	const sent = [];
	const handlers = {};
	const win = { command: (n, d) => sent.push([n, JSON.parse(JSON.stringify(d))]), attachEvent: (n, f) => { handlers[n] = f; } };
	const runs = [];
	env.ctx.chatWindow = win;
	return {
		...env, win, sent, handlers, runs, editorEvents,
		attach() { env.ctx.SelectionSuggestions.attach(win, (text, force) => runs.push([text, force])); }
	};
}

describe("SelectionSuggestions", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test("word: sends chips for a stable selection, debounced and deduplicated", async () => {
		const fake = createWordDocument({ body: ["Hello world", "Other"] });
		const s = suggestionsEnv("word", fake);
		s.attach();
		await vi.advanceTimersByTimeAsync(500);
		expect(s.sent).toEqual([["onSelectionSuggestions", { key: "", summary: "", actions: [] }]]);

		fake.doc.selection = [{ para: fake.doc.elements[0], start: 0, end: 11 }];
		s.editorEvents.onTargetPositionChanged();
		await vi.advanceTimersByTimeAsync(399);
		expect(s.sent).toHaveLength(1); // still debouncing (first probe sees a change)
		await vi.advanceTimersByTimeAsync(500);
		expect(s.sent).toHaveLength(2);
		expect(s.sent[1][1].summary).toBe("Selected text (11 chars)");
		expect(s.sent[1][1].actions.map((a) => a.id)).toEqual(["improve", "continue"]);
		expect(s.sent[1][1].actions[0]).toEqual({ id: "improve", text: "Improve writing" });

		await vi.advanceTimersByTimeAsync(5000);
		expect(s.sent).toHaveLength(2); // polling without changes sends nothing
	});

	test("a chip click runs its prompt and pauses suggestions until the agent is done", async () => {
		const fake = createWordDocument({ body: ["Hello world"], selection: { paragraph: 1 } });
		const s = suggestionsEnv("word", fake);
		s.attach();
		await vi.advanceTimersByTimeAsync(1000);
		expect(s.sent).toHaveLength(1);

		s.handlers.onSmartActionChip({ id: "improve" });
		expect(s.runs).toHaveLength(1);
		expect(s.runs[0][0]).toBe(s.ctx.SmartActions.byId("word", "improve").prompt + s.ctx.SmartActions.LANG_HINT);
		expect(s.runs[0][1]).toBe(true);

		s.handlers.onSmartActionChip({ id: "nope" });
		s.handlers.onSmartActionChip(null);
		expect(s.runs).toHaveLength(1);

		fake.doc.selection = [{ para: fake.doc.elements[0], start: 0, end: 5 }];
		await vi.advanceTimersByTimeAsync(5000);
		expect(s.sent).toHaveLength(1); // busy

		s.handlers.onSelectionSuggestionsBusy(false);
		await vi.advanceTimersByTimeAsync(1000);
		expect(s.sent).toHaveLength(2);
		expect(s.sent[1][1].summary).toBe("Selected text (5 chars)");
	});

	test("stops polling once the chat window is closed", async () => {
		const fake = createWordDocument({ body: ["Hello"] });
		const s = suggestionsEnv("word", fake);
		s.attach();
		await vi.advanceTimersByTimeAsync(1000);
		s.ctx.chatWindow = null;
		fake.doc.selection = [{ para: fake.doc.elements[0], start: 0, end: 5 }];
		await vi.advanceTimersByTimeAsync(10000);
		expect(s.sent).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("re-attaching (e.g. after docking) resends the current state once", async () => {
		const fake = createWordDocument({ body: ["Hello"], selection: { paragraph: 1 } });
		const s = suggestionsEnv("word", fake);
		s.attach();
		await vi.advanceTimersByTimeAsync(1000);
		s.attach();
		await vi.advanceTimersByTimeAsync(1000);
		expect(s.sent).toHaveLength(2);
		expect(s.sent[0][1]).toEqual(s.sent[1][1]);
	});

	test("cell: polls the selection address and suggests from the data", async () => {
		const fake = createWorkbook({ sheets: { S: [["Month", "Sales", "Cost"], ["Jan", 1, 2], ["Feb", 2, 3], ["Mar", 3, 4]] }, selection: "A1" });
		const s = suggestionsEnv("cell", fake);
		s.attach();
		expect(s.editorEvents.onTargetPositionChanged).toBeUndefined(); // cells are polled
		await vi.advanceTimersByTimeAsync(1000);
		expect(s.sent[0][1].actions.map((a) => a.id)).toEqual(["cleanUp"]);

		fake.wb.selection = fake.wb.active.GetRange("A1:C4");
		await vi.advanceTimersByTimeAsync(1500 + 400 + 100);
		expect(s.sent).toHaveLength(2);
		expect(s.sent[1][1].summary).toBe("Selection: A1:C4");
		expect(s.sent[1][1].actions.map((a) => a.id)).toEqual(["chart", "insights", "explainData"]);
	});

	test("does nothing for editors without smart actions", async () => {
		const s = suggestionsEnv("pdf", { methods: { GetSelectedText: () => "x" } });
		s.attach();
		await vi.advanceTimersByTimeAsync(5000);
		expect(s.sent).toEqual([]);
	});
});
