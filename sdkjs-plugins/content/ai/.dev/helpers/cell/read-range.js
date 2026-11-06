/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "readRange",
		"category": "core",
		"readOnly": true,
		"text": "Read Cells",
		"description": "Reads cell values (and optionally formulas) from the spreadsheet as a 2D array of rows. If 'range' is omitted the user's current selection is read; if the selection is a single cell, the sheet's used range is returned instead when 'expandToUsedRange' is true. Large ranges are truncated to 'maxRows' x 'maxColumns'; the response tells you the full size. Use this to analyse, explain, summarise or transform data before writing results back with writeRange.",
		"parameters": {
			"type": "object",
			"properties": {
				"range": {
					"type": "string",
					"description": "A1-style address, e.g. 'A1:D20' or 'B:B'. Defaults to the current selection."
				},
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				},
				"includeFormulas": {
					"type": "boolean",
					"description": "Also return formulas for cells that contain them.",
					"default": false
				},
				"expandToUsedRange": {
					"type": "boolean",
					"description": "When no range is given and only one cell is selected, read the whole used range of the sheet.",
					"default": false
				},
				"maxRows": {
					"type": "number",
					"description": "Maximum number of rows to return (1-1000).",
					"default": 200
				},
				"maxColumns": {
					"type": "number",
					"description": "Maximum number of columns to return (1-100).",
					"default": 50
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "Explain the selected data",
				"arguments": {}
			},
			{
				"prompt": "What is in A1:C10 on Sheet2?",
				"arguments": { "range": "A1:C10", "sheet": "Sheet2" }
			},
			{
				"prompt": "Check my formulas",
				"arguments": { "includeFormulas": true, "expandToUsedRange": true }
			}
		]
	});

	func.call = async function(params) {
		if (params.range !== undefined && params.range !== null && typeof params.range !== 'string')
			throw new window.AgentState.ToolError('Parameter "range" must be an A1-style string. Got: ' + JSON.stringify(params.range));
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));

		Asc.scope.readParams = {
			range: params.range || null,
			sheet: params.sheet || null,
			includeFormulas: !!params.includeFormulas,
			expand: !!params.expandToUsedRange,
			maxRows: Math.max(1, Math.min(1000, Math.floor(params.maxRows || 200))),
			maxCols: Math.max(1, Math.min(100, Math.floor(params.maxColumns || 50)))
		};

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.readParams;
			let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
			if (!ws)
				return { error: "Sheet \"" + p.sheet + "\" not found." };

			let range = null;
			if (p.range) {
				try {
					range = ws.GetRange(p.range); // ApiWorksheet.GetRange throws on an invalid address
				} catch (e) {}
				if (!range)
					return { error: "Invalid range \"" + p.range + "\"." };
			} else {
				range = Api.GetSelection();
				if (range && p.expand && range.GetRowsCount() === 1 && range.GetColumnsCount() === 1) {
					let used = ws.GetUsedRange();
					if (used)
						range = used;
				}
			}
			if (!range)
				return { error: "No range selected." };

			let totalRows = range.GetRowsCount();
			let totalCols = range.GetColumnsCount();

			// Clip whole-column / whole-row references to the used range
			let used = ws.GetUsedRange();
			let firstRow = range.GetRow();
			let firstCol = range.GetCol();
			if (used) {
				let lastUsedRow = used.GetRow() + used.GetRowsCount() - 1;
				let lastUsedCol = used.GetCol() + used.GetColumnsCount() - 1;
				totalRows = Math.max(0, Math.min(totalRows, lastUsedRow - firstRow + 1));
				totalCols = Math.max(0, Math.min(totalCols, lastUsedCol - firstCol + 1));
			}

			let rows = Math.min(totalRows, p.maxRows);
			let cols = Math.min(totalCols, p.maxCols);
			let values = [];
			let formulas = {};
			for (let r = 0; r < rows; r++) {
				let row = [];
				for (let c = 0; c < cols; c++) {
					let cell = ws.GetRangeByNumber(firstRow - 1 + r, firstCol - 1 + c);
					let v = cell.GetValue();
					row.push(v === undefined || v === null ? "" : v);
					if (p.includeFormulas) {
						let f = cell.GetFormula();
						if (f && String(f).charAt(0) === "=")
							formulas[cell.GetAddress(false, false)] = f;
					}
				}
				values.push(row);
			}

			let address = range.GetAddress(false, false);
			let res = {
				sheet: ws.GetName(),
				address: address,
				topLeft: ws.GetRangeByNumber(firstRow - 1, firstCol - 1).GetAddress(false, false),
				totalRows: totalRows,
				totalColumns: totalCols,
				values: values
			};
			if (rows < totalRows || cols < totalCols)
				res.truncated = true;
			if (p.includeFormulas)
				res.formulas = formulas;
			return res;
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	func.describe = function(args, result) {
		let where = args.range ? (args.sheet ? args.sheet + "!" : "") + args.range : "";
		let read = result && result.address ? (result.sheet ? result.sheet + "!" : "") + result.address : "";
		return {
			start: where ? toolText("Read cells %1", where) : toolText("Read the selected cells"),
			done: read ? toolText("Read cells %1", read) : "",
			phrase: toolText("read cells")
		};
	};

	return func;
})();
