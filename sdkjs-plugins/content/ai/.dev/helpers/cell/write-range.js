/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "writeRange",
		"category": "edit-text",
		"text": "Write Cells",
		"description": "Writes a 2D array of values into the spreadsheet starting at a top-left cell. Strings that start with '=' are entered as formulas (use English function names and commas as separators). Use null to leave a cell unchanged and an empty string to clear it. Use it to fill in computed results, cleaned data, new columns, totals or formulas. The whole write is a single undo step.",
		"parameters": {
			"type": "object",
			"properties": {
				"startCell": {
					"type": "string",
					"description": "Top-left cell address, e.g. 'E2'. Defaults to the top-left cell of the current selection."
				},
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				},
				"values": {
					"type": "array",
					"description": "Rows of cell values. Each row is an array of strings, numbers, booleans or null.",
					"items": {
						"type": "array",
						"items": {}
					}
				}
			},
			"required": ["values"]
		},
		"examples": [
			{
				"prompt": "Add a Total column with sums for rows 2-4",
				"arguments": { "startCell": "E1", "values": [["Total"], ["=SUM(B2:D2)"], ["=SUM(B3:D3)"], ["=SUM(B4:D4)"]] }
			},
			{
				"prompt": "Put the cleaned names back into the selection",
				"arguments": { "values": [["Anna Smith"], ["John Doe"]] }
			}
		]
	});

	func.call = async function(params) {
		if (!Array.isArray(params.values) || params.values.length === 0)
			throw new window.AgentState.ToolError('Parameter "values" must be a non-empty 2D array (array of rows).');
		for (let i = 0; i < params.values.length; i++) {
			if (!Array.isArray(params.values[i]))
				throw new window.AgentState.ToolError('Row ' + i + ' of "values" is not an array. "values" must be an array of rows, e.g. [["a", 1], ["b", 2]].');
		}
		if (params.startCell !== undefined && params.startCell !== null && typeof params.startCell !== 'string')
			throw new window.AgentState.ToolError('Parameter "startCell" must be an A1-style string.');

		Asc.scope.writeParams = {
			startCell: params.startCell || null,
			sheet: params.sheet || null,
			values: params.values
		};

		await Asc.Editor.callMethod("StartAction", ["GroupActions"]);
		let result;
		try {
			result = await Asc.Editor.callCommand(function(){
				let p = Asc.scope.writeParams;
				let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
				if (!ws)
					return { error: "Sheet \"" + p.sheet + "\" not found." };

				let start = null;
				try {
					start = p.startCell ? ws.GetRange(p.startCell) : Api.GetSelection(); // ApiWorksheet.GetRange throws on an invalid address
				} catch (e) {}
				if (!start)
					return { error: "Invalid start cell \"" + p.startCell + "\"." };

				let row0 = start.GetRow() - 1;
				let col0 = start.GetCol() - 1;
				let written = 0;
				let maxCols = 0;
				for (let r = 0; r < p.values.length; r++) {
					let row = p.values[r];
					maxCols = Math.max(maxCols, row.length);
					for (let c = 0; c < row.length; c++) {
						let v = row[c];
						if (v === null || v === undefined)
							continue;
						// SetValue enters strings starting with "=" as formulas
						ws.GetRangeByNumber(row0 + r, col0 + c).SetValue(v);
						written++;
					}
				}
				let first = ws.GetRangeByNumber(row0, col0).GetAddress(false, false);
				let last = ws.GetRangeByNumber(row0 + p.values.length - 1, col0 + Math.max(0, maxCols - 1)).GetAddress(false, false);
				return {
					sheet: ws.GetName(),
					range: first === last ? first : first + ":" + last,
					cellsWritten: written
				};
			});
		} finally {
			await Asc.Editor.callMethod("EndAction", ["GroupActions"]);
		}

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	func.describe = function(args, result) {
		let count = 0;
		(Array.isArray(args.values) ? args.values : []).forEach(function(row) { count += Array.isArray(row) ? row.length : 1; });
		return {
			start: toolText("Write %1 cells to %2", count, (args.sheet ? args.sheet + "!" : "") + (args.startCell || "")),
			done: result && toolText("Wrote %1 cells to %2", result.cellsWritten, result.sheet + "!" + result.range),
			phrase: toolText("wrote cells")
		};
	};

	return func;
})();
