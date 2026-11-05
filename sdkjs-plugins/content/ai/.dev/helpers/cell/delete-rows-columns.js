(function(){
	let func = new RegisteredFunction({
		"name": "deleteRowsColumns",
		"category": "structure",
		"text": "Delete Rows or Columns",
		"description": "Deletes whole rows or whole columns (including their content) from a worksheet. Cells below/right of them shift up/left; formulas pointing at deleted cells become #REF!. Rows are 1-based numbers, columns are letters (A, B, ..., XFD). Read the affected cells first if unsure.",
		"parameters": {
			"type": "object",
			"properties": {
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				},
				"type": {
					"type": "string",
					"enum": ["rows", "columns"],
					"description": "Whether to delete whole rows or whole columns."
				},
				"at": {
					"type": "string",
					"description": "First row/column to delete: for rows a 1-based row number (e.g. '5'); for columns a column letter (e.g. 'C')."
				},
				"count": {
					"type": "number",
					"description": "How many rows/columns to delete (1-1000).",
					"default": 1
				}
			},
			"required": ["type", "at"]
		},
		"examples": [
			{
				"prompt": "Delete rows 10 to 12",
				"arguments": { "type": "rows", "at": "10", "count": 3 }
			},
			{
				"prompt": "Remove column F",
				"arguments": { "type": "columns", "at": "F" }
			}
		]
	});

	func.call = async function(params) {
		const MAX_ROWS = 1048576, MAX_COLS = 16384;
		if (params.type !== "rows" && params.type !== "columns")
			throw new window.AgentState.ToolError('Parameter "type" must be "rows" or "columns". Got: ' + JSON.stringify(params.type));
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));
		let count = params.count === undefined || params.count === null ? 1 : params.count;
		if (typeof count !== 'number' || count < 1 || count > 1000)
			throw new window.AgentState.ToolError('Parameter "count" must be a number between 1 and 1000. Got: ' + JSON.stringify(params.count));
		count = Math.floor(count);

		function colName(n) {
			let s = "";
			while (n > 0) {
				let m = (n - 1) % 26;
				s = String.fromCharCode(65 + m) + s;
				n = Math.floor((n - 1) / 26);
			}
			return s;
		}
		function colNumber(letters) {
			let n = 0;
			for (let i = 0; i < letters.length; i++)
				n = n * 26 + (letters.charCodeAt(i) - 64);
			return n;
		}

		let first, address;
		if (params.type === "rows") {
			first = typeof params.at === 'string' && /^\s*\d+\s*$/.test(params.at) ? parseInt(params.at, 10) : params.at;
			if (typeof first !== 'number' || !isFinite(first) || first < 1)
				throw new window.AgentState.ToolError('For rows, "at" must be a 1-based row number, e.g. 5. Got: ' + JSON.stringify(params.at));
			first = Math.floor(first);
			if (first + count - 1 > MAX_ROWS)
				throw new window.AgentState.ToolError('Rows ' + first + '-' + (first + count - 1) + ' exceed the sheet limit of ' + MAX_ROWS + ' rows.');
			address = first + ":" + (first + count - 1);
		} else {
			if (typeof params.at === 'number')
				first = Math.floor(params.at);
			else if (typeof params.at === 'string' && /^\s*\d+\s*$/.test(params.at))
				first = parseInt(params.at, 10);
			else if (typeof params.at === 'string' && /^\s*[A-Za-z]{1,3}\s*$/.test(params.at))
				first = colNumber(params.at.trim().toUpperCase());
			else
				first = NaN;
			if (!isFinite(first) || first < 1)
				throw new window.AgentState.ToolError('For columns, "at" must be a column letter such as "C" (or a 1-based column number). Got: ' + JSON.stringify(params.at));
			if (first + count - 1 > MAX_COLS)
				throw new window.AgentState.ToolError('Columns exceed the sheet limit of ' + MAX_COLS + ' columns (XFD).');
			address = colName(first) + ":" + colName(first + count - 1);
		}

		Asc.scope.structParams = { sheet: params.sheet || null, address: address, shift: params.type === "rows" ? "up" : "left" };

		let result;
		await Asc.Editor.callMethod("StartAction", ["GroupActions"]);
		try {
			result = await Asc.Editor.callCommand(function(){
				let p = Asc.scope.structParams;
				let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
				if (!ws)
					return { error: "Sheet \"" + p.sheet + "\" not found. Available sheets: " + Api.GetSheets().map(function(s){ return s.GetName(); }).join(", ") };
				let range = ws.GetRange(p.address);
				if (!range)
					return { error: "Invalid address \"" + p.address + "\"." };
				range.Delete(p.shift);
				return { sheet: ws.GetName(), deleted: p.address };
			});
		} catch (e) {
			throw new window.AgentState.ToolError("Could not delete " + address + ": " + (e && e.message ? e.message : String(e)) + " (the sheet may be protected).");
		} finally {
			await Asc.Editor.callMethod("EndAction", ["GroupActions"]);
		}

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
