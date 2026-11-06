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

describe("selectRange", () => {
	test("selectRange selects on the active or a named sheet", async () => {
		const env = cell(SALES);
		expect(await env.call("selectRange", { range: " B2:C4 " })).toEqual({ sheet: "Sales", selected: "B2:C4" });
		expect(await env.call("selectRange", { range: "A1", sheet: "Notes" })).toEqual({ sheet: "Notes", selected: "A1" });
		expect(env.wb.active.name).toBe("Notes");
		await expectToolError(env.call("selectRange", { range: "" }), /"range" must be an A1-style string/);
	});

});

describe("invalid addresses", () => {
	// ApiWorksheet.GetRange throws in the editor; the command must still
	// return a clear error instead of an empty "success".
	test.each([
		["readRange", { range: "A1:" }, /Invalid range "A1:"/],
		["writeRange", { startCell: "1A", values: [["x"]] }, /Invalid start cell "1A"/],
		["selectRange", { range: "Sheet 2" }, /Invalid range "Sheet 2"/]
	])("%s %j", async (tool, args, msg) => {
		const env = cell(SALES);
		await expectToolError(env.call(tool, args), msg);
		expect(env.host.commandErrors).toEqual([]);
	});
});
