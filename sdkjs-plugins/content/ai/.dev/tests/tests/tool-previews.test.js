// SPDX-License-Identifier: AGPL-3.0-only
//
// Approval previews (scripts/helpers/toolPreviews.js)
// (ported from the mock tests that came with the feature).

import { test } from "vitest";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../fakes/aiedits/mocks.cjs");


function colName(n) { let s = ""; while (n > 0) { let m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function parseA1(a) { const m = /^([A-Z]+)(\d+)$/.exec(a); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return { r: +m[2] - 1, c: c - 1 }; }

// Spreadsheet mock: cells keyed "r,c" -> { text, formula }
function cellApi(ctx, cells, selection) {
	function range(r, c) {
		const v = cells[r + "," + c] || {};
		return {
			GetRow: () => r + 1, GetCol: () => c + 1,
			GetText: () => v.text || "",
			GetFormula: () => v.formula || v.text || "",
			GetAddress: () => colName(c + 1) + (r + 1),
			GetNumberFormat: () => v.format || "General",
			GetValidation: () => ({ GetType: () => v.validation || null, GetFormula1: () => v.f1 || null, GetFormula2: () => null })
		};
	}
	const ws = {
		GetName: () => "Sheet1",
		GetRange: (a) => { const p = parseA1(a.split(":")[0]); const r = range(p.r, p.c); r.GetAddress = () => a; return r; },
		GetRangeByNumber: (r, c) => range(r, c),
		GetUsedRange: () => { const r = range(0, 0); r.GetAddress = () => "A1:C4"; return r; }
	};
	ctx.Api = { GetActiveSheet: () => ws, GetSheet: (n) => (n === "Sheet1" ? ws : null), GetSelection: () => ws.GetRange(selection || "B2"), GetSheets: () => [ws] };
}

function setup(editorType, defs) {
	const ctx = M.baseContext(editorType);
	defs.forEach((name) => M.addTool(ctx, editorType, { name: name }, async () => ({})));
	ctx.EditorHelper = new ctx.EditorHelperImpl();
	return ctx;
}


	test("writeRange: current vs new values for the target cells", async () => {
		const ctx = setup("cell", ["writeRange"]);
		cellApi(ctx, { "1,4": { text: "old" }, "2,4": { text: "5", formula: "=2+3" } });
		const prev = await ctx.ToolApproval.getPreview("writeRange", { startCell: "E2", values: [["Total"], ["=SUM(B3:D3)"], [null]] });
		assert.strictEqual(prev.items[0].value, "Sheet1");
		assert.strictEqual(prev.items[1].value, "E2:E4");
		assert.deepStrictEqual(prev.table.columns, ["E"]);
		assert.deepStrictEqual(prev.table.rows.map((r) => r.label), ["2", "3", "4"]);
		assert.deepStrictEqual(prev.table.rows[0].cells[0], { before: "old", after: "Total" });
		assert.deepStrictEqual(prev.table.rows[1].cells[0], { before: "=2+3", after: "=SUM(B3:D3)" });
		assert.deepStrictEqual(prev.table.rows[2].cells[0], { before: "", after: "" }, "null keeps the cell");
		assert.strictEqual(prev.table.truncated, false);
	});

	test("writeRange: capped at 10x6 and flagged as truncated", async () => {
		const ctx = setup("cell", ["writeRange"]);
		cellApi(ctx, {}, "A1");
		const values = Array.from({ length: 15 }, (_, r) => Array.from({ length: 8 }, (_, c) => r * 10 + c));
		const prev = await ctx.ToolApproval.getPreview("writeRange", { values: values });
		assert.strictEqual(prev.table.rows.length, 10);
		assert.strictEqual(prev.table.columns.length, 6);
		assert.strictEqual(prev.table.truncated, true);
		assert.strictEqual(prev.items[1].value, "A1:H15");
	});

	test("writeRange: invalid arguments give no preview (the tool reports the error)", async () => {
		const ctx = setup("cell", ["writeRange"]);
		cellApi(ctx, {});
		assert.strictEqual(await ctx.ToolApproval.getPreview("writeRange", { values: "x" }), null);
		assert.strictEqual(await ctx.ToolApproval.getPreview("writeRange", { values: [1, 2] }), null);
	});

	test("replaceSelection (presentation): old vs new text", async () => {
		const ctx = setup("slide", ["replaceSelection"]);
		ctx.selectedText = "Hello wrld";
		const prev = await ctx.ToolApproval.getPreview("replaceSelection", { text: "Hello world" });
		assert.deepStrictEqual(prev.text, { before: "Hello wrld", after: "Hello world" });
		ctx.selectedText = "";
		assert.strictEqual(await ctx.ToolApproval.getPreview("replaceSelection", { text: "x" }), null);
	});

	test("setNumberFormat / setDataValidation: range and rule", async () => {
		const ctx = setup("cell", ["setNumberFormat", "setDataValidation"]);
		cellApi(ctx, { "1,1": { text: "1234.5", format: "General", validation: "xlValidateWholeNumber", f1: "1" } });
		const nf = await ctx.ToolApproval.getPreview("setNumberFormat", { range: "B2:B9", format: "#,##0.00" });
		assert.deepStrictEqual(nf.items.map((i) => i.value).slice(0, 4), ["Sheet1", "B2:B9", "General", "#,##0.00"]);
		const dv = await ctx.ToolApproval.getPreview("setDataValidation", { range: "B2:B9", type: "list", values: ["Open", "Done"] });
		assert.strictEqual(dv.items[2].value, "xlValidateWholeNumber: 1 (B2)");
		assert.strictEqual(dv.items[3].value, "list: Open, Done");
	});

	test("deleteRowsColumns / insertRowsColumns / manageSheet: what is affected", async () => {
		const ctx = setup("cell", ["deleteRowsColumns", "insertRowsColumns", "manageSheet"]);
		cellApi(ctx, { "1,0": { text: "a" }, "1,2": { text: "c" }, "2,1": { text: "b" } });
		const del = await ctx.ToolApproval.getPreview("deleteRowsColumns", { type: "rows", at: "2", count: 2 });
		assert.strictEqual(del.items[1].value, "Rows 2:3");
		assert.strictEqual(del.items[2].value, "3");
		assert.deepStrictEqual(del.table.rows.map((r) => r.label), ["2", "3"]);
		const ins = await ctx.ToolApproval.getPreview("insertRowsColumns", { type: "columns", at: "C" });
		assert.strictEqual(ins.items[1].value, "Columns C:C");
		const ms = await ctx.ToolApproval.getPreview("manageSheet", { action: "delete", name: "sheet1" });
		assert.strictEqual(ms.items[1].value, "A1:C4");
		assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.ToolPreviews.rowsColumnsAddress({ type: "columns", at: "AA", count: 2 }))),
			{ type: "columns", first: 27, last: 28, address: "AA:AB" });
		assert.strictEqual(ctx.ToolPreviews.rowsColumnsAddress({ type: "rows", at: "x" }), null);
	});

	test("preview is attached but never sent to the model (getTools)", async () => {
		const ctx = setup("cell", ["writeRange"]);
		assert.strictEqual(typeof ctx.EditorHelper.names2funcs.writeRange.preview, "function");
		const tools = ctx.EditorHelper.getTools();
		const t = tools.find((x) => x.name === "writeRange");
		assert.ok(t);
		assert.strictEqual(t.preview, undefined);
		assert.strictEqual(t.managesTrackChanges, undefined);
	});

	test("a failing preview does not block the approval", async () => {
		const ctx = setup("cell", ["writeRange"]);
		ctx.Api = { GetActiveSheet: () => { throw new Error("no"); } };
		assert.strictEqual(await ctx.ToolApproval.getPreview("writeRange", { values: [[1]] }), null);
	});

