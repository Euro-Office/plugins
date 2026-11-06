// SPDX-FileCopyrightText: Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Layer 2 (cell): spreadsheet tools against the in-memory Spreadsheet API fake.

import { describe, test, expect } from "vitest";
import { createToolEnv, expectToolError } from "../lib/plugin.js";
import { createWorkbook } from "../fakes/cell.js";

function cell(spec) {
	const fake = createWorkbook(spec);
	const env = createToolEnv("cell", fake);
	return { ...env, wb: fake.wb, sheet: fake.sheet };
}

const SALES = {
	sheets: {
		Sales: [
			["Month", "Revenue", "Cost", "Profit"],
			["Jan", 100, 60, { v: "40", f: "=B2-C2" }],
			["Feb", 120, 70, { v: "50", f: "=B3-C3" }],
			["Mar", 90, 95, { v: "-5", f: "=B4-C4" }],
			["Total", { v: "310", f: "=SUM(B2:B4)" }, "", { v: "#DIV/0!", f: "=D2/0" }]
		],
		Notes: { B3: "remember", A1: "Title" },
		Empty: []
	},
	active: "Sales",
	selection: "A1:B3"
};

describe("getWorkbookInfo", () => {
	test("lists sheets with used ranges, the active sheet and the selection", async () => {
		const r = await cell(SALES).call("getWorkbookInfo");
		expect(r).toEqual({
			activeSheet: "Sales",
			selection: "A1:B3",
			sheets: [
				{ name: "Sales", usedRange: "A1:D5", rows: 5, columns: 4 },
				{ name: "Notes", usedRange: "A1:B3", rows: 3, columns: 2 },
				{ name: "Empty", usedRange: "A1", rows: 1, columns: 1 }
			]
		});
	});
});

describe("readRange", () => {
	test("reads an explicit range with values as displayed", async () => {
		const r = await cell(SALES).call("readRange", { range: "A1:B2" });
		expect(r).toEqual({ sheet: "Sales", address: "A1:B2", topLeft: "A1", totalRows: 2, totalColumns: 2, values: [["Month", "Revenue"], ["Jan", "100"]] });
	});

	test("defaults to the selection; expandToUsedRange widens a single cell", async () => {
		const env = cell({ ...SALES, selection: "C3" });
		expect((await env.call("readRange")).values).toEqual([["70"]]);
		const r = await env.call("readRange", { expandToUsedRange: true });
		expect(r.address).toBe("A1:D5");
		expect(r.values).toHaveLength(5);
	});

	test("whole-column and whole-row references are clipped to the used range", async () => {
		const env = cell(SALES);
		const col = await env.call("readRange", { range: "B:B" });
		expect(col).toMatchObject({ address: "B:B", topLeft: "B1", totalRows: 5, totalColumns: 1 });
		expect(col.values.map((r) => r[0])).toEqual(["Revenue", "100", "120", "90", "310"]);
		const row = await env.call("readRange", { range: "2:2" });
		expect(row).toMatchObject({ address: "2:2", totalRows: 1, totalColumns: 4, values: [["Jan", "100", "60", "40"]] });
	});

	test("a range entirely outside the used range is empty", async () => {
		const r = await cell(SALES).call("readRange", { range: "H10:J12" });
		expect(r).toMatchObject({ totalRows: 0, totalColumns: 0, values: [] });
	});

	test("includeFormulas returns formulas by address", async () => {
		const r = await cell(SALES).call("readRange", { range: "B5:D5", includeFormulas: true });
		expect(r.formulas).toEqual({ B5: "= SUM(B2:B4)", D5: "= D2/0" });
	});

	test("truncates to maxRows/maxColumns", async () => {
		const r = await cell(SALES).call("readRange", { range: "A1:D5", maxRows: 2, maxColumns: 3 });
		expect(r).toMatchObject({ totalRows: 5, totalColumns: 4, truncated: true });
		expect(r.values).toEqual([["Month", "Revenue", "Cost"], ["Jan", "100", "60"]]);
	});

	test("reads another sheet by name", async () => {
		const r = await cell(SALES).call("readRange", { sheet: "Notes", range: "B3" });
		expect(r).toMatchObject({ sheet: "Notes", values: [["remember"]] });
	});

	test("argument and lookup errors", async () => {
		const env = cell(SALES);
		await expectToolError(env.call("readRange", { range: 5 }), /"range" must be an A1-style string/);
		await expectToolError(env.call("readRange", { sheet: 1 }), /"sheet" must be a string/);
		await expectToolError(env.call("readRange", { sheet: "Nope", range: "A1" }), /Sheet "Nope" not found/);
	});

	test("an invalid address is reported as an error, not as success", async () => {
		// ApiWorksheet.GetRange throws on bad addresses in the real editor.
		await expectToolError(cell(SALES).call("readRange", { range: "Sales!!A1" }), /Invalid range/);
	});
});

describe("writeRange", () => {
	test("writes values and formulas from the start cell in one undo group", async () => {
		const env = cell(SALES);
		const r = await env.call("writeRange", { startCell: "F1", values: [["Margin"], ["=D2/B2"], [0.5]] });
		expect(r).toEqual({ sheet: "Sales", range: "F1:F3", cellsWritten: 3 });
		const ws = env.sheet("Sales");
		expect(ws.value("F1")).toBe("Margin");
		expect(ws.formula("F2")).toBe("=D2/B2");
		expect(ws.value("F3")).toBe("0.5");
		expect(env.host.methodCalls().map((c) => c.name)).toEqual(["StartAction", "EndAction"]);
	});

	test("null/undefined cells are skipped; ragged rows size the reported range", async () => {
		const env = cell(SALES);
		const r = await env.call("writeRange", { startCell: "B2", values: [[null, 1, 2], [3]] });
		expect(r).toEqual({ sheet: "Sales", range: "B2:D3", cellsWritten: 3 });
		expect(env.sheet("Sales").value("B2")).toBe("100");
		expect(env.sheet("Sales").value("C2")).toBe("1");
	});

	test("defaults to the selection's top-left cell and supports other sheets", async () => {
		const env = cell({ ...SALES, selection: "C7" });
		expect((await env.call("writeRange", { values: [["x"]] })).range).toBe("C7");
		expect((await env.call("writeRange", { sheet: "Empty", startCell: "A1", values: [["y"]] })).sheet).toBe("Empty");
		expect(env.sheet("Empty").value("A1")).toBe("y");
	});

	test("validates arguments", async () => {
		const env = cell(SALES);
		await expectToolError(env.call("writeRange", { values: [] }), /non-empty 2D array/);
		await expectToolError(env.call("writeRange", { values: ["a", "b"] }), /Row 0 of "values" is not an array/);
		await expectToolError(env.call("writeRange", { values: [["a"]], startCell: 3 }), /"startCell"/);
		await expectToolError(env.call("writeRange", { values: [["a"]], sheet: "Nope" }), /Sheet "Nope" not found/);
		expect(env.host.methodCalls("EndAction")).toHaveLength(1); // closed even on error
	});

	test("an invalid start cell is reported as an error", async () => {
		await expectToolError(cell(SALES).call("writeRange", { startCell: "nope", values: [["a"]] }), /Invalid start cell/);
	});
});

describe("findInSheet", () => {
	test("finds substrings case-insensitively with addresses", async () => {
		const r = await cell(SALES).call("findInSheet", { query: "a" });
		expect(r.matches.map((m) => m.address)).toEqual(["A2", "A4", "A5"]); // Jan, Mar, Total
		expect(r.totalMatches).toBe(3);
	});

	test("wholeCell, matchCase, numbers, all sheets and limits", async () => {
		const env = cell(SALES);
		expect((await env.call("findInSheet", { query: "jan", wholeCell: true })).matches).toEqual([{ sheet: "Sales", address: "A2", value: "Jan" }]);
		expect((await env.call("findInSheet", { query: "jan", matchCase: true })).totalMatches).toBe(0);
		expect((await env.call("findInSheet", { query: 120 })).matches[0].address).toBe("B3");
		const all = await env.call("findInSheet", { query: "e", allSheets: true, maxResults: 2 });
		expect(all).toMatchObject({ returned: 2, truncated: true });
		expect(all.totalMatches).toBeGreaterThan(2);
		expect((await env.call("findInSheet", { query: "remember", allSheets: true })).matches).toEqual([{ sheet: "Notes", address: "B3", value: "remember" }]);
		await expectToolError(env.call("findInSheet", { query: "" }), /"query"/);
		await expectToolError(env.call("findInSheet", { query: "x", sheet: "Nope" }), /Sheet "Nope" not found\. Available sheets: Sales, Notes, Empty/);
	});
});

describe("findFormulaErrors", () => {
	test("reports error cells with their formula", async () => {
		const r = await cell(SALES).call("findFormulaErrors");
		expect(r).toEqual({ totalErrors: 1, byType: { "#DIV/0!": 1 }, returned: 1, errors: [{ sheet: "Sales", address: "D5", error: "#DIV/0!", formula: "=D2/0" }] });
	});

	test("clean sheets and validation", async () => {
		const env = cell(SALES);
		expect((await env.call("findFormulaErrors", { sheet: "Notes" })).totalErrors).toBe(0);
		await expectToolError(env.call("findFormulaErrors", { maxResults: 0 }), /"maxResults"/);
	});
});

describe("insertRowsColumns / deleteRowsColumns", () => {
	test("insert rows shifts data down", async () => {
		const env = cell(SALES);
		expect(await env.call("insertRowsColumns", { type: "rows", at: 2, count: 2 })).toEqual({ sheet: "Sales", inserted: "2:3" });
		expect(env.sheet("Sales").value("A4")).toBe("Jan");
		expect(env.sheet("Sales").value("A2")).toBe("");
	});

	test("insert columns by letter shifts data right", async () => {
		const env = cell(SALES);
		expect(await env.call("insertRowsColumns", { type: "columns", at: "b" })).toEqual({ sheet: "Sales", inserted: "B:B" });
		expect(env.sheet("Sales").value("C1")).toBe("Revenue");
	});

	test("delete rows and columns", async () => {
		const env = cell(SALES);
		expect(await env.call("deleteRowsColumns", { type: "rows", at: "2" })).toEqual({ sheet: "Sales", deleted: "2:2" });
		expect(env.sheet("Sales").value("A2")).toBe("Feb");
		expect(await env.call("deleteRowsColumns", { type: "columns", at: 2, count: 2 })).toEqual({ sheet: "Sales", deleted: "B:C" });
		expect(env.sheet("Sales").value("B1")).toBe("Profit");
	});

	test.each([
		["insertRowsColumns", { type: "cells", at: 1 }, /"type" must be "rows" or "columns"/],
		["insertRowsColumns", { type: "rows", at: "B" }, /For rows, "at" must be a 1-based row number/],
		["insertRowsColumns", { type: "columns", at: "B2" }, /For columns, "at" must be a column letter/],
		["insertRowsColumns", { type: "rows", at: 1, count: 1001 }, /"count" must be a number between 1 and 1000/],
		["insertRowsColumns", { type: "rows", at: 1048576, count: 2 }, /exceed the sheet limit/],
		["deleteRowsColumns", { type: "columns", at: "XFD", count: 2 }, /exceed the sheet limit/],
		["deleteRowsColumns", { type: "rows", at: 1, sheet: "Nope" }, /Sheet "Nope" not found/]
	])("%s rejects %j", async (tool, args, msg) => {
		await expectToolError(cell(SALES).call(tool, args), msg);
	});
});

describe("manageSheet", () => {
	test("add, rename, activate and delete", async () => {
		const env = cell(SALES);
		expect(await env.call("manageSheet", { action: "add", name: "Q2" })).toEqual({ action: "add", sheets: ["Sales", "Notes", "Empty", "Q2"], activeSheet: "Q2" });
		expect((await env.call("manageSheet", { action: "rename", name: "q2", newName: "Q2 2026" })).sheets).toContain("Q2 2026");
		expect((await env.call("manageSheet", { action: "activate", name: "notes" })).activeSheet).toBe("Notes");
		expect((await env.call("manageSheet", { action: "delete", name: "Empty" })).sheets).toEqual(["Sales", "Notes", "Q2 2026"]);
	});

	test("rejects duplicates, missing sheets, bad names and deleting the last sheet", async () => {
		const env = cell(SALES);
		await expectToolError(env.call("manageSheet", { action: "add", name: "sales" }), /already exists/);
		await expectToolError(env.call("manageSheet", { action: "rename", name: "Sales", newName: "Notes" }), /already exists/);
		await expectToolError(env.call("manageSheet", { action: "delete", name: "Nope" }), /not found/);
		await expectToolError(env.call("manageSheet", { action: "add", name: "a/b" }), /not allowed in sheet names/);
		await expectToolError(env.call("manageSheet", { action: "add", name: "x".repeat(32) }), /at most 31 characters/);
		await expectToolError(env.call("manageSheet", { action: "add", name: "'quoted'" }), /apostrophe/);
		await expectToolError(env.call("manageSheet", { action: "rename", name: "Sales" }), /"newName" is required/);
		await expectToolError(env.call("manageSheet", { action: "copy", name: "Sales" }), /"action" must be one of/);
		const single = cell({ sheets: { Only: [] } });
		await expectToolError(single.call("manageSheet", { action: "delete", name: "Only" }), /Cannot delete the only sheet/);
	});

	test("an apostrophe inside a name is allowed", async () => {
		expect((await cell(SALES).call("manageSheet", { action: "add", name: "Bob's data" })).activeSheet).toBe("Bob's data");
	});
});

describe("selectRange / freezePanes / setNumberFormat", () => {
	test("selectRange selects on the active or a named sheet", async () => {
		const env = cell(SALES);
		expect(await env.call("selectRange", { range: " B2:C4 " })).toEqual({ sheet: "Sales", selected: "B2:C4" });
		expect(await env.call("selectRange", { range: "A1", sheet: "Notes" })).toEqual({ sheet: "Notes", selected: "A1" });
		expect(env.wb.active.name).toBe("Notes");
		await expectToolError(env.call("selectRange", { range: "" }), /"range" must be an A1-style string/);
	});

	test("freezePanes by rows, columns, cell and unfreeze", async () => {
		const env = cell(SALES);
		expect(await env.call("freezePanes", { rows: 1 })).toEqual({ sheet: "Sales", frozenRows: 1, frozenColumns: 0, frozenRange: "1:1" });
		expect(await env.call("freezePanes", { columns: 1 })).toMatchObject({ frozenRows: 0, frozenColumns: 1, frozenRange: "A:A" });
		expect(await env.call("freezePanes", { cell: "C3" })).toMatchObject({ frozenRows: 2, frozenColumns: 2, frozenRange: "A1:B2" });
		expect(await env.call("freezePanes", { unfreeze: true })).toMatchObject({ frozenRows: 0, frozenColumns: 0, frozenRange: null });
		expect(await env.call("freezePanes", { rows: 0, columns: 0 })).toMatchObject({ frozenRange: null });
		await expectToolError(env.call("freezePanes", {}), /Pass "rows" and\/or "columns"/);
		await expectToolError(env.call("freezePanes", { cell: "B2:C3" }), /single cell address/);
		await expectToolError(env.call("freezePanes", { rows: -1 }), /"rows" must be a number >= 0/);
	});

	test("setNumberFormat applies to a range and shows a sample", async () => {
		const env = cell({ sheets: { S: [[0.25, 0.5]] } });
		const r = await env.call("setNumberFormat", { range: "A1:B1", format: "0.00%" });
		expect(r).toEqual({ sheet: "S", range: "A1:B1", format: "0.00%", sample: { address: "A1", displayed: "25.00%" } });
		expect(env.sheet("S").cell("B1").numFmt).toBe("0.00%");
		await expectToolError(env.call("setNumberFormat", { format: "" }), /"format" must be a non-empty number format code/);
	});
});

describe("setDataValidation", () => {
	test("list from values", async () => {
		const env = cell(SALES);
		const r = await env.call("setDataValidation", { range: "E2:E10", type: "list", values: ["Open", " Done ", ""] });
		expect(r).toMatchObject({ range: "E2:E10", type: "xlValidateList", operator: "xlBetween", formula1: "Open,Done", formula2: null });
		expect(env.sheet("Sales").validations).toHaveLength(1);
	});

	test("list from a source range gets a leading =", async () => {
		const r = await cell(SALES).call("setDataValidation", { range: "E2", type: "list", source: "$H$2:$H$5" });
		expect(r.formula1).toBe("=$H$2:$H$5");
	});

	test("numbers with operators and an error message; replaces the previous rule", async () => {
		const env = cell(SALES);
		await env.call("setDataValidation", { range: "B2:B4", type: "whole", min: 0, max: 100 });
		const r = await env.call("setDataValidation", { range: "B2:B4", type: "decimal", operator: "greater", min: 0, max: 5, errorMessage: "Positive only" });
		expect(r).toMatchObject({ type: "xlValidateDecimal", operator: "xlGreater", formula1: "0", formula2: null });
		const rules = env.sheet("Sales").validations;
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({ showError: true, errorMessage: "Positive only" });
	});

	test("type none removes validation", async () => {
		const env = cell(SALES);
		await env.call("setDataValidation", { range: "B2:B4", type: "whole", min: 1, max: 2 });
		expect(await env.call("setDataValidation", { range: "B2:B4", type: "none" })).toEqual({ sheet: "Sales", range: "B2:B4", removed: true });
		expect(env.sheet("Sales").validations).toHaveLength(0);
	});

	test.each([
		[{ range: "A1", type: "regex" }, /"type" must be one of/],
		[{ range: "A1", type: "list" }, /needs "values"/],
		[{ range: "A1", type: "list", values: ["a,b"] }, /must not contain commas/],
		[{ range: "A1", type: "list", values: ["x".repeat(300)] }, /too long/],
		[{ range: "A1", type: "custom" }, /needs the formula in "min"/],
		[{ range: "A1", type: "whole" }, /needs "min"/],
		[{ range: "A1", type: "whole", min: 1 }, /needs both "min" and "max"/],
		[{ range: "A1", type: "whole", min: 1, max: 2, operator: "approx" }, /"operator" must be one of/],
		[{ range: "A1", type: "whole", min: 1, max: 2, alertStyle: "loud" }, /"alertStyle"/],
		[{ type: "whole" }, /"range" must be an A1-style string/]
	])("rejects %j", async (args, msg) => {
		await expectToolError(cell(SALES).call("setDataValidation", args), msg);
	});
});

describe("comments", () => {
	const spec = {
		...SALES,
		comments: [
			{ sheet: "Sales", id: "1", cell: "B3", author: "Ann", text: "Too high?", replies: [{ author: "Ben", text: "No" }] },
			{ sheet: "Notes", id: "2", cell: "A1", text: "Old", solved: true }
		]
	};

	test("getComments maps comments to cells on every sheet", async () => {
		const r = await cell(spec).call("getComments");
		expect(r).toMatchObject({ totalComments: 2, returned: 2 });
		expect(r.comments[0]).toEqual({ id: "1", sheet: "Sales", address: "B3", author: "Ann", text: "Too high?", resolved: false, cellValue: "120", replies: [{ author: "Ben", text: "No" }] });
		const open = await cell(spec).call("getComments", { includeResolved: false });
		expect(open.comments.map((c) => c.id)).toEqual(["1"]);
		const notes = await cell(spec).call("getComments", { sheet: "Notes" });
		expect(notes.comments.map((c) => c.address)).toEqual(["A1"]);
	});

	test("replyToComment replies and/or resolves", async () => {
		const env = cell(spec);
		expect(await env.call("replyToComment", { commentId: "1", text: "Checked." })).toEqual({ commentId: "1", replies: 2, resolved: false });
		expect(await env.call("replyToComment", { commentId: 1, resolved: true })).toEqual({ commentId: "1", replies: 2, resolved: true });
		await expectToolError(env.call("replyToComment", { commentId: "1" }), /Provide a non-empty "text"/);
		await expectToolError(env.call("replyToComment", { commentId: "9", text: "x" }), /Comment "9" not found/);
	});
});

describe("invalid addresses", () => {
	// ApiWorksheet.GetRange throws in the editor; the command must still
	// return a clear error instead of an empty "success".
	test.each([
		["readRange", { range: "A1:" }, /Invalid range "A1:"/],
		["writeRange", { startCell: "1A", values: [["x"]] }, /Invalid start cell "1A"/],
		["selectRange", { range: "Sheet 2" }, /Invalid range "Sheet 2"/],
		["setNumberFormat", { range: "ZZZZ1", format: "0" }, /Invalid range "ZZZZ1"/],
		["setDataValidation", { range: "B2-B9", type: "whole", min: 1, max: 2 }, /Invalid range "B2-B9"/]
	])("%s %j", async (tool, args, msg) => {
		const env = cell(SALES);
		await expectToolError(env.call(tool, args), msg);
		expect(env.host.commandErrors).toEqual([]);
	});
});

describe("addChart", () => {
	test("creates the chart and reports it", async () => {
		const env = cell(SALES);
		expect(await env.call("addChart", { range: "A1:B4", title: "Revenue" })).toEqual({ created: true, range: "A1:B4" });
		expect(env.sheet("Sales").charts.map((c) => [c.ref, c.title])).toEqual([["A1:B4", "Revenue"]]);
	});

	test("rejects multi-area ranges before touching the sheet", async () => {
		const env = cell(SALES);
		await expectToolError(env.call("addChart", { range: "A1:A13,G1:G13" }), /one contiguous range/);
		expect(env.sheet("Sales").charts).toBeUndefined();
	});

	test("an exception inside the command is an error, not a success", async () => {
		const env = cell(SALES);
		await expectToolError(env.call("addChart", { range: "nonsense" }), /not created.*Incorrect "Range1"/);
	});
});
