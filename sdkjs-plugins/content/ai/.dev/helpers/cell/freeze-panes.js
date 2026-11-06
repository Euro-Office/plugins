/*
 * SPDX-FileCopyrightText: Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
(function(){
	let func = new RegisteredFunction({
		"name": "freezePanes",
		"category": "structure",
		"text": "Freeze Panes",
		"description": "Freezes rows and/or columns so they stay visible while scrolling, or removes the freeze. Either pass 'rows' and/or 'columns' (number of top rows / left columns to freeze), or 'cell' (Excel semantics: everything above and to the left of this cell is frozen, e.g. 'B2' freezes row 1 and column A), or 'unfreeze': true. Applies to the given sheet, which becomes the active sheet.",
		"parameters": {
			"type": "object",
			"properties": {
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				},
				"rows": {
					"type": "number",
					"description": "Number of top rows to freeze (0 = none)."
				},
				"columns": {
					"type": "number",
					"description": "Number of left columns to freeze (0 = none)."
				},
				"cell": {
					"type": "string",
					"description": "Top-left cell of the scrollable area, e.g. 'B2'. Alternative to rows/columns."
				},
				"unfreeze": {
					"type": "boolean",
					"description": "Remove any frozen panes.",
					"default": false
				}
			},
			"required": []
		},
		"examples": [
			{
				"prompt": "Keep the header row visible",
				"arguments": { "rows": 1 }
			},
			{
				"prompt": "Freeze the first row and the first column",
				"arguments": { "cell": "B2" }
			},
			{
				"prompt": "Unfreeze panes",
				"arguments": { "unfreeze": true }
			}
		]
	});

	func.call = async function(params) {
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));
		let rows = 0, cols = 0;
		let unfreeze = params.unfreeze === true;
		if (!unfreeze) {
			if (typeof params.cell === 'string' && params.cell.trim() !== "") {
				let m = /^\s*\$?([A-Za-z]{1,3})\$?(\d+)\s*$/.exec(params.cell);
				if (!m)
					throw new window.AgentState.ToolError('Parameter "cell" must be a single cell address such as "B2". Got: ' + JSON.stringify(params.cell));
				let letters = m[1].toUpperCase();
				let col = 0;
				for (let i = 0; i < letters.length; i++)
					col = col * 26 + (letters.charCodeAt(i) - 64);
				rows = parseInt(m[2], 10) - 1;
				cols = col - 1;
			} else {
				if (params.rows !== undefined && params.rows !== null) {
					if (typeof params.rows !== 'number' || params.rows < 0)
						throw new window.AgentState.ToolError('Parameter "rows" must be a number >= 0. Got: ' + JSON.stringify(params.rows));
					rows = Math.floor(params.rows);
				}
				if (params.columns !== undefined && params.columns !== null) {
					if (typeof params.columns !== 'number' || params.columns < 0)
						throw new window.AgentState.ToolError('Parameter "columns" must be a number >= 0. Got: ' + JSON.stringify(params.columns));
					cols = Math.floor(params.columns);
				}
			}
			if (rows === 0 && cols === 0) {
				if (params.rows === undefined && params.columns === undefined && params.cell === undefined)
					throw new window.AgentState.ToolError('Pass "rows" and/or "columns", or "cell", or "unfreeze": true.');
				unfreeze = true;
			}
		}

		Asc.scope.freezeParams = { sheet: params.sheet || null, rows: rows, cols: cols, unfreeze: unfreeze };

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.freezeParams;
			let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
			if (!ws)
				return { error: "Sheet \"" + p.sheet + "\" not found. Available sheets: " + Api.GetSheets().map(function(s){ return s.GetName(); }).join(", ") };
			// Freeze panes act on the active sheet's view
			ws.SetActive();
			let panes = ws.GetFreezePanes();
			function colName(n) {
				let s = "";
				while (n > 0) {
					let m = (n - 1) % 26;
					s = String.fromCharCode(65 + m) + s;
					n = Math.floor((n - 1) / 26);
				}
				return s;
			}
			if (p.unfreeze) {
				panes.Unfreeze();
			} else if (p.rows > 0 && p.cols > 0) {
				panes.FreezeAt("A1:" + colName(p.cols) + p.rows);
			} else if (p.rows > 0) {
				panes.FreezeRows(p.rows);
			} else {
				panes.FreezeColumns(p.cols);
			}
			let loc = panes.GetLocation();
			return {
				sheet: ws.GetName(),
				frozenRows: p.unfreeze ? 0 : p.rows,
				frozenColumns: p.unfreeze ? 0 : p.cols,
				frozenRange: loc ? loc.GetAddress(false, false) : null
			};
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
