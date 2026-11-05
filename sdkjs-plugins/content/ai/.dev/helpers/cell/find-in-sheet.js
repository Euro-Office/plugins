(function(){
	let func = new RegisteredFunction({
		"name": "findInSheet",
		"readOnly": true,
		"text": "Find in Sheet",
		"description": "Searches cell values in the used range of a worksheet (or of all worksheets) for a text or number and returns the matching cells with sheet name, A1 address and value. Values are compared as text; by default a cell matches when it contains the query anywhere (case-insensitive). Use wholeCell to require the entire cell value to equal the query. Formulas are not searched, only their results. Use it to locate data before reading or editing it with readRange/writeRange.",
		"parameters": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "Text to search for. Numbers can be passed as text, e.g. '1250'."
				},
				"sheet": {
					"type": "string",
					"description": "Sheet name. Defaults to the active sheet."
				},
				"allSheets": {
					"type": "boolean",
					"description": "Search every worksheet instead of a single one.",
					"default": false
				},
				"matchCase": {
					"type": "boolean",
					"description": "Case-sensitive comparison.",
					"default": false
				},
				"wholeCell": {
					"type": "boolean",
					"description": "Match only cells whose entire value equals the query.",
					"default": false
				},
				"maxResults": {
					"type": "number",
					"description": "Maximum number of matches to return (1-500).",
					"default": 100
				}
			},
			"required": ["query"]
		},
		"examples": [
			{
				"prompt": "Where is the customer 'Müller' listed?",
				"arguments": { "query": "Müller", "allSheets": true }
			},
			{
				"prompt": "Find cells that are exactly 'N/A' on Sheet1",
				"arguments": { "query": "N/A", "sheet": "Sheet1", "wholeCell": true }
			}
		]
	});

	func.call = async function(params) {
		if ((typeof params.query !== 'string' && typeof params.query !== 'number') || String(params.query) === "")
			throw new window.AgentState.ToolError('Parameter "query" must be a non-empty string. Got: ' + JSON.stringify(params.query));
		if (params.sheet !== undefined && params.sheet !== null && typeof params.sheet !== 'string')
			throw new window.AgentState.ToolError('Parameter "sheet" must be a string. Got: ' + JSON.stringify(params.sheet));
		let max = params.maxResults === undefined || params.maxResults === null ? 100 : params.maxResults;
		if (typeof max !== 'number' || max < 1)
			throw new window.AgentState.ToolError('Parameter "maxResults" must be a number >= 1. Got: ' + JSON.stringify(params.maxResults));

		Asc.scope.findParams = {
			query: String(params.query),
			sheet: params.sheet || null,
			allSheets: params.allSheets === true,
			matchCase: params.matchCase === true,
			wholeCell: params.wholeCell === true,
			max: Math.min(500, Math.floor(max)),
			maxCells: 500000
		};

		let result = await Asc.Editor.callCommand(function(){
			let p = Asc.scope.findParams;
			let sheets;
			if (p.allSheets) {
				sheets = Api.GetSheets();
			} else {
				let ws = p.sheet ? Api.GetSheet(p.sheet) : Api.GetActiveSheet();
				if (!ws)
					return { error: "Sheet \"" + p.sheet + "\" not found. Available sheets: " + Api.GetSheets().map(function(s){ return s.GetName(); }).join(", ") };
				sheets = [ws];
			}

			function colName(n) {
				let s = "";
				while (n > 0) {
					let m = (n - 1) % 26;
					s = String.fromCharCode(65 + m) + s;
					n = Math.floor((n - 1) / 26);
				}
				return s;
			}

			let needle = p.matchCase ? p.query : p.query.toLowerCase();
			let matches = [];
			let total = 0;
			let truncatedScan = false;
			let budget = p.maxCells;
			for (let s = 0; s < sheets.length; s++) {
				let ws = sheets[s];
				let used = ws.GetUsedRange();
				if (!used)
					continue;
				let rows = used.GetRowsCount();
				let cols = used.GetColumnsCount();
				let row0 = used.GetRow();
				let col0 = used.GetCol();
				if (rows * cols > budget) {
					rows = Math.max(1, Math.floor(budget / cols));
					truncatedScan = true;
				}
				budget -= rows * cols;
				let scan = rows === used.GetRowsCount() ? used : ws.GetRange(colName(col0) + row0 + ":" + colName(col0 + cols - 1) + (row0 + rows - 1));
				let values = scan.GetValue();
				if (!Array.isArray(values))
					values = [[values]];
				for (let r = 0; r < values.length; r++) {
					let row = Array.isArray(values[r]) ? values[r] : [values[r]];
					for (let c = 0; c < row.length; c++) {
						let v = row[c];
						if (v === null || v === undefined || v === "")
							continue;
						let sv = String(v);
						let hay = p.matchCase ? sv : sv.toLowerCase();
						if (p.wholeCell ? hay.trim() !== needle.trim() : hay.indexOf(needle) === -1)
							continue;
						total++;
						if (matches.length < p.max)
							matches.push({ sheet: ws.GetName(), address: colName(col0 + c) + (row0 + r), value: v });
					}
				}
				if (budget <= 0)
					break;
			}
			let res = { query: p.query, totalMatches: total, returned: matches.length, matches: matches };
			if (total > matches.length)
				res.truncated = true;
			if (truncatedScan)
				res.warning = "The sheet is very large; only the first " + p.maxCells + " cells were searched.";
			return res;
		});

		if (result && result.error)
			throw new window.AgentState.ToolError(result.error);
		return result;
	};

	return func;
})();
